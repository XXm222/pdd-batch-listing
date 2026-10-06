import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

export type BridgeSetupStatus = {
  state:
    'ready' | 'extension_disconnected' | 'service_unavailable' | 'version_mismatch' | 'unsupported';
  message: string;
  httpAddress: string;
  wsAddress: string;
  serviceVersion?: string;
  extensionVersion?: string;
  suggestedCommand?: string;
};

const defaultAddress = 'http://127.0.0.1:10086';
type ServiceStatus = Record<string, unknown> & { running: boolean };
type Inspection = { result: BridgeSetupStatus; executable?: string; canStart: boolean };

/** Starting a task may wake the default browser; checking the help panel must remain read-only. */
export async function ensureBrowserReady(
  setup: Pick<BridgeSetup, 'start' | 'check'>,
  openBrowser: () => Promise<unknown>,
  timeoutMs = 12000,
): Promise<BridgeSetupStatus> {
  let status = await setup.start();
  if (status.state !== 'extension_disconnected') return status;
  await openBrowser();
  const deadline = Date.now() + timeoutMs;
  do {
    status = await setup.check();
    if (status.state !== 'extension_disconnected') return status;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return {
    ...status,
    message:
      '已打开系统默认浏览器，但没有收到 Kimi 扩展连接。请在要使用的浏览器中安装并连接扩展，再继续原任务。',
  };
}

function loopbackAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const address = new URL(value.includes('://') ? value : `http://${value}`);
    if (
      address.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(address.hostname) ||
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      address.pathname !== '/'
    )
      return;
    const port = Number(address.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    address.hostname = '127.0.0.1';
    return address.origin;
  } catch {
    return;
  }
}

function parseStatus(value: unknown): ServiceStatus | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as ServiceStatus).running !== 'boolean'
  )
    return;
  return value as ServiceStatus;
}

function releasePair(value: string): string | undefined {
  return value.match(/^v?(\d+\.\d+)(?:\.\d+)?(?:[-+].*)?$/)?.[1];
}

/** Uses the official bundled CLI; it never stops services or edits the user's bridge configuration. */
export class BridgeSetup {
  private checking?: Promise<Inspection>;
  private starting?: Promise<BridgeSetupStatus>;
  constructor(
    private readonly resourcesRoot = path
      .resolve(__dirname, '../../resources')
      .replace(/(^|[\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked'),
  ) {}

  private executable() {
    const target = `${process.platform}-${process.arch}`;
    if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) return;
    return path.join(
      this.resourcesRoot,
      'bridge-runtime',
      target,
      process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge',
    );
  }

  private run(executable: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  }

  private result(
    state: BridgeSetupStatus['state'],
    message: string,
    address = defaultAddress,
    data?: ServiceStatus,
  ): BridgeSetupStatus {
    const result: BridgeSetupStatus = {
      state,
      message,
      httpAddress: address,
      wsAddress: `${address.replace(/^http:/, 'ws:')}/ws`,
    };
    if (typeof data?.version === 'string') result.serviceVersion = data.version;
    if (typeof data?.extension_version === 'string' && data.extension_version)
      result.extensionVersion = data.extension_version;
    const mismatch = data?.version_mismatch;
    if (
      mismatch &&
      typeof mismatch === 'object' &&
      typeof (mismatch as Record<string, unknown>).command === 'string'
    ) {
      result.suggestedCommand = (mismatch as { command: string }).command;
    }
    return result;
  }

  private async probe(address: string): Promise<BridgeSetupStatus | undefined> {
    try {
      const response = await fetch(`${address}/status`, {
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
      });
      if (!response.ok) return;
      const data = parseStatus(await response.json());
      if (
        !data?.running ||
        typeof data.extension_connected !== 'boolean' ||
        typeof data.version !== 'string'
      )
        return;
      if (!data.extension_connected)
        return this.result(
          'extension_disconnected',
          '浏览器扩展尚未连接。请打开浏览器，确认扩展已启用，并核对扩展中的本机连接地址。',
          address,
          data,
        );
      const servicePair = releasePair(data.version);
      const extensionPair =
        typeof data.extension_version === 'string'
          ? releasePair(data.extension_version)
          : undefined;
      if (
        data.version_mismatch ||
        !servicePair ||
        !extensionPair ||
        servicePair !== extensionPair
      ) {
        return this.result(
          'version_mismatch',
          '浏览器扩展与本机服务的版本不匹配或无法确认，请按照安装教程检查版本后重试。',
          address,
          data,
        );
      }
      return this.result('ready', '浏览器已连接，可以继续填写商品。', address, data);
    } catch {
      return;
    }
  }

  private async inspect(): Promise<Inspection> {
    const executable = this.executable();
    if (!executable)
      return {
        canStart: false,
        result: this.result(
          'unsupported',
          '当前系统暂不支持浏览器连接，请使用 Mac（Apple 芯片或 Intel）或 Windows 64 位版本。',
        ),
      };
    let address = defaultAddress;
    // The official daemon writes its actual bound address here. This is a runtime record, not its configuration.
    try {
      const savedAddress = fs
        .readFileSync(path.join(os.homedir(), '.kimi-webbridge', 'daemon.addr'), 'utf8')
        .trim();
      const local = loopbackAddress(savedAddress);
      if (!local)
        return {
          canStart: false,
          result: this.result(
            'service_unavailable',
            '浏览器服务地址不是有效的本机回环地址，请将其设为本机地址后再连接。',
          ),
        };
      address = local;
    } catch {
      /* A first-time installation has no running-daemon record yet. */
    }
    const bundled = fs.existsSync(executable);
    // A connected daemon can be reused even when the bundled CLI is absent, and does not need repeated CLI version queries.
    const existing = await this.probe(address);
    if (existing) return { executable, canStart: false, result: existing };
    const probedAddress = address;
    if (bundled) {
      try {
        const status = parseStatus(JSON.parse(await this.run(executable, ['status'], 5000)));
        if (status) {
          if (typeof status.addr === 'string') {
            const local = loopbackAddress(status.addr);
            if (!local)
              return {
                canStart: false,
                result: this.result(
                  'service_unavailable',
                  '浏览器服务地址不是有效的本机回环地址，请将其设为本机地址后再连接。',
                ),
              };
            address = local;
          } else if (
            status.running &&
            typeof status.port === 'number' &&
            Number.isInteger(status.port)
          ) {
            const local = loopbackAddress(`127.0.0.1:${status.port}`);
            if (!local)
              return {
                canStart: false,
                result: this.result(
                  'service_unavailable',
                  '浏览器服务返回了无效端口，请检查本机服务。',
                ),
              };
            address = local;
          }
        }
      } catch {
        /* The HTTP probe below also permits reusing an already-running service. */
      }
    }
    const discovered = address !== probedAddress ? await this.probe(address) : undefined;
    if (discovered) return { executable, canStart: false, result: discovered };
    return {
      executable,
      canStart: bundled,
      result: this.result(
        'service_unavailable',
        bundled
          ? '本机浏览器服务尚未连接，请点击“启动并检测”。'
          : 'App 内的浏览器服务文件缺失，请重新安装完整版本。',
        address,
      ),
    };
  }

  private inspection(): Promise<Inspection> {
    if (!this.checking)
      this.checking = this.inspect().finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  async check(): Promise<BridgeSetupStatus> {
    return (await this.inspection()).result;
  }

  start(): Promise<BridgeSetupStatus> {
    if (!this.starting)
      this.starting = this.startService().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private async startService(): Promise<BridgeSetupStatus> {
    const initial = await this.inspection();
    if (!initial.canStart || !initial.executable) return initial.result;
    try {
      // Explicitly keep a stopped service on its configured loopback address. The official start command reuses a live service.
      await this.run(
        initial.executable,
        ['start', '--addr', new URL(initial.result.httpAddress).host],
        15000,
      );
    } catch {
      // Another App action may have started it meanwhile; a current status takes precedence over the CLI exit code.
      const current = await this.check();
      if (current.state !== 'service_unavailable') return current;
      return {
        ...current,
        message:
          '本机浏览器服务启动失败，可能是端口被占用或服务文件不可用。请查看安装教程后重新检测。',
      };
    }
    return this.check();
  }
}
