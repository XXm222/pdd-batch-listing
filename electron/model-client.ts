import type { AgentConfigInput } from '../src/types';

export type ModelMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
};
type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
export type ModelReply = { message: ModelMessage; tokens?: number; finishReason?: string };
// Only structural descriptions leave the parser; never persist raw model
// arguments or vendor debug data in an error message.
export class ModelToolFormatError extends Error {
  constructor(reason: string) {
    super(`模型工具请求格式不正确：${reason}`);
  }
}
function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) throw new ModelToolFormatError('tool_calls 应为数组');
  if (value.length > 6) throw new ModelToolFormatError('单次工具数量超过 6 个');
  const ids = new Set<string>();
  return value.map((call: any) => {
    if (!call || typeof call !== 'object' || Array.isArray(call))
      throw new ModelToolFormatError('工具记录应为对象');
    if (
      typeof call.id !== 'string' ||
      !call.id.trim() ||
      call.id.length > 128 ||
      /[\u0000-\u001f]/.test(call.id)
    )
      throw new ModelToolFormatError('工具调用 ID 缺失或无效');
    if (ids.has(call.id)) throw new ModelToolFormatError('工具调用 ID 重复');
    ids.add(call.id);
    if (call.type !== undefined && call.type !== 'function')
      throw new ModelToolFormatError('工具类型不是 function');
    if (
      typeof call.function?.name !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(call.function.name)
    )
      throw new ModelToolFormatError('工具函数名称缺失或无效');
    // Some compatible endpoints deserialize arguments into a JSON object or
    // omit the redundant function type. Normalize their transport shape only;
    // AgentService still checks the offered name and its empty-argument schema.
    const args =
      typeof call.function.arguments === 'string'
        ? call.function.arguments
        : call.function.arguments &&
            typeof call.function.arguments === 'object' &&
            !Array.isArray(call.function.arguments)
          ? JSON.stringify(call.function.arguments)
          : undefined;
    if (args === undefined) throw new ModelToolFormatError('工具参数须为 JSON 字符串或对象');
    if (args.length > 4096) throw new ModelToolFormatError('工具参数超过长度限制');
    return {
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: args },
    };
  });
}
export function validateConfig(input: AgentConfigInput) {
  if (
    !input ||
    typeof input.baseUrl !== 'string' ||
    typeof input.model !== 'string' ||
    typeof input.apiKey !== 'string'
  )
    throw new Error('请填写模型接口地址、模型名与密钥');
  let u: URL;
  try {
    u = new URL(input.baseUrl.trim());
  } catch {
    throw new Error('模型接口地址格式不正确');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (!['https:'].includes(u.protocol) && !(u.protocol === 'http:' && local))
  )
    throw new Error('云端接口需要 HTTPS；本机服务可以使用 http://127.0.0.1');
  const baseUrl = u
    .toString()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  const model = input.model.trim();
  if (!model || model.length > 160 || /[\r\n]/.test(model)) throw new Error('请填写有效的模型名称');
  const apiKey = input.apiKey.trim();
  if (apiKey.length > 4096 || /[\r\n\x00]/.test(apiKey)) throw new Error('API Key 格式不正确');
  return { baseUrl, model, apiKey, local };
}
export class ModelClient {
  constructor(private config: { baseUrl: string; model: string; apiKey: string }) {}
  async complete(
    messages: ModelMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    options: { maxTokens?: number } = {},
  ): Promise<ModelReply> {
    const timeout = AbortSignal.timeout(40000);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: stop,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          max_tokens: options.maxTokens ?? 1800,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
        }),
      });
    } catch (error) {
      throw new Error(
        stop.aborted ? '模型请求超时，请稍后重试' : '无法连接模型接口，请检查地址与网络',
        { cause: error },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? '模型认证失败，请检查 API Key 与模型权限'
          : response.status === 429
            ? '模型请求受限，请检查额度或稍后重试'
            : `模型接口返回 HTTP ${response.status}，请检查接口与模型名`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('模型接口未返回内容');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 512 * 1024) {
          await reader.cancel();
          throw new Error('模型响应过大，请使用适合诊断的模型');
        }
        chunks.push(value);
      }
    } catch (e) {
      if (stop.aborted) throw new Error('模型响应超时，请稍后重试', { cause: e });
      throw e;
    } finally {
      reader.releaseLock();
    }
    let data: any;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      throw new Error('模型接口返回了无法识别的内容', { cause: error });
    }
    const m = data?.choices?.[0]?.message;
    const content =
      typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content) &&
            m.content.every(
              (part: any) =>
                part &&
                ['text', 'output_text'].includes(part.type) &&
                typeof part.text === 'string',
            )
          ? m.content.map((part: any) => part.text).join('')
          : null;
    if (!m || (content === null && m.tool_calls == null && typeof m.reasoning_content !== 'string'))
      throw new Error('模型接口缺少有效回答，请确认兼容 Chat Completions');
    if (content && content.length > 20000) throw new Error('模型回答过长，请更换模型或重试');
    // Preserve documented tool-call conversation fields, never return vendor debug data.
    const message: ModelMessage = { role: 'assistant', content };
    if (m.reasoning_content && typeof m.reasoning_content === 'string')
      message.reasoning_content = m.reasoning_content.slice(0, 60000);
    if (m.tool_calls != null) message.tool_calls = normalizeToolCalls(m.tool_calls);
    const tokens =
      Number.isSafeInteger(data.usage?.total_tokens) && data.usage.total_tokens >= 0
        ? data.usage.total_tokens
        : undefined;
    return {
      message,
      tokens,
      finishReason:
        typeof data.choices[0].finish_reason === 'string'
          ? data.choices[0].finish_reason
          : undefined,
    };
  }
}
