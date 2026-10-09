import type { PlatformId } from './platforms';

export type Asset = {
  id: string;
  name: string;
  url: string;
  bytes: number;
  width: number;
  height: number;
  format?: 'png' | 'jpg';
};
export type ImageTarget = { kind: 'main' | 'detail' | 'sku'; index?: number };
export type Sku = {
  spec: string;
  group: string;
  single: string;
  stock: string;
  code?: string;
  image?: string;
  options?: { name: string; value: string }[];
};
export type ProductAttribute = { name: string; value: string; required: boolean };
export type Services = { sevenDay: string; invoice: string; authenticity: string };
/**
 * 淘宝/天猫发品专有设置。拼多多模板没有这些项，因此整体可选：
 * 只有 `taobao` 存在时，才是淘宝模板导入的商品。
 */
export type TaobaoListing = {
  /** 发货地，天猫必填且必须级联到市。 */
  originProvince: string;
  originCity: string;
  /** 提取方式：邮寄 / 电子交易凭证。 */
  extractWay: string;
  /** 运费承担：卖家承担 / 买家承担。 */
  freightBearer: string;
  /** 发货时间：今日发 / 48小时 / 大于48小时。 */
  deliveryTime: string;
  /** 上架时间：放入仓库 / 立刻上架 / 定时上架。 */
  shelfTime: string;
  /** 返点比例，0.5–1.5，须为 0.5 的整数倍。 */
  auctionPoint: string;
};
export type Product = {
  id: string;
  code: string;
  title: string;
  category: string;
  brand: string;
  material: string;
  audience: string;
  foldable: string;
  reference: string;
  skuCode: string;
  discount: string;
  shipping: string;
  freight: string;
  expectedShop: string;
  demo: boolean;
  source: string;
  skus: Sku[];
  /** 商家编码。天猫是独立于货号的选填字段；未填时沿用商品编码。 */
  outerId?: string;
  main: string[];
  detail: string[];
  /** 淘宝专有的选填图片位；拼多多商品为空数组。 */
  threeToFour?: string[];
  whiteBg?: string[];
  usp?: string[];
  /** 淘宝发品设置；拼多多商品为 undefined。 */
  taobao?: TaobaoListing;
  images: Record<string, Asset>;
  savedAt?: string;
  templateFormat: string;
  attributes?: ProductAttribute[];
  services?: Services;
  demoDeclared?: boolean;
};
export type Shop = {
  id: string;
  name: string;
  account: string;
  credentialsSaved: boolean;
  updatedAt: string;
  /** 旧资料没有该字段，读取时按拼多多处理，见 platforms.ts。 */
  platform?: PlatformId;
};
export type ShopGoods = {
  goodsId: string;
  title: string;
  thumbnail: string;
  price: string;
  editUrl?: string;
  status?: 'waiting' | 'reading' | 'done' | 'failed' | 'stopped';
  message?: string;
};
export type CollectionState = {
  shopId: string;
  shopName: string;
  status: 'idle' | 'listing' | 'ready' | 'exporting' | 'done' | 'error' | 'cancelled';
  message: string;
  goods: ShopGoods[];
  completeList: boolean;
  completed: number;
  total: number;
  outputPath?: string;
  exportIds?: string[];
};
export type ShopLoginStatus =
  'running' | 'succeeded' | 'verification_required' | 'credentials_rejected' | 'failed';
export type ShopLoginEvent = {
  name: string;
  startedAt: string;
  status: 'running' | 'done' | 'failed';
  durationMs?: number;
};
export type ShopLoginResult = {
  shopId: string;
  status: ShopLoginStatus;
  message: string;
  startedAt: string;
  durationMs?: number;
  events: ShopLoginEvent[];
  errorCode?: TaskErrorCode;
};
export type TaskStatus =
  'prepared' | 'running' | 'awaiting_user' | 'succeeded' | 'failed' | 'uncertain';
export type TaskStep =
  | 'connect'
  | 'login'
  | 'resources'
  | 'form'
  | 'basic'
  | 'skus'
  | 'services'
  | 'images'
  | 'pre_save'
  | 'save'
  | 'saved_fields'
  | 'draft_list';
export type RecoveryAction =
  'retry' | 'inspect_form' | 'readback' | 'edit_product' | 'confirm_shop' | 'restart_form';
export type TaskErrorCode =
  | 'invalid_product'
  | 'shop_changed'
  | 'login_required'
  | 'browser_unavailable'
  | 'page_timeout'
  | 'form_changed'
  | 'form_lost'
  | 'upload_uncertain'
  | 'save_uncertain'
  | 'paused'
  | 'platform_changed';
export type BackendCheck = {
  key?: string;
  label: string;
  status: 'pending' | 'passed' | 'failed' | 'not_checked' | 'not_applicable';
  message?: string;
  checkedAt?: string;
  stage?: 'form' | 'saved';
};
export type StepTiming = {
  name: string;
  step?: TaskStep;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'done' | 'failed' | 'interrupted';
};
export type Task = {
  id: string;
  shopId: string;
  shopName: string;
  /** 建任务时店铺所属平台；旧任务没有该字段，按店铺当前平台处理。 */
  platform?: PlatformId;
  code: string;
  title: string;
  status: TaskStatus;
  time: string;
  productSnapshot: Product;
  /** New PDD tasks use API; absent on legacy tasks. Retries keep their original writer. */
  executionMode?: 'pdd_api';
  apiDraft?: {
    createAttemptedAt?: string;
    commitId?: string;
    categoryId?: number;
    freightId?: number;
    services?: { refund: number; invoice: number; authenticity: number };
    uploads?: Record<string, { url: string; width: number; height: number }>;
  };
  backendChecks?: BackendCheck[];
  phase?: string;
  message?: string;
  formUrl?: string;
  goodsId?: string;
  saveAttemptedAt?: string;
  result?: { goodsId: string; status: string; shopName: string; title: string; verifiedAt: string };
  logs?: { time: string; message: string }[];
  evidence?: string;
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  timings?: StepTiming[];
  runElapsedMs?: number;
  revision?: number;
  clearedAt?: string | null;
  shopSnapshot?: { name: string; account: string; updatedAt: string; platform?: PlatformId };
  checkpoint?: { step: TaskStep; state: 'running' | 'done'; updatedAt: string };
  error?: {
    code: TaskErrorCode;
    message: string;
    recovery: RecoveryAction;
    details?: Record<string, unknown>;
  };
  /** One-use Agent recovery intent: verify an existing login, never submit credentials. */
  loginCheckOnly?: true;
  skuImageManifest?: {
    goodsId: string;
    slots: Record<string, { assetId: string; remoteUrl: string }>;
  };
  uploadManifest?: { goodsId: string; main: string[]; detail: string[] };
  uploadSubmission?: { goodsId: string; main?: string[]; detail?: string[] };
  previousGoodsIds?: string[];
  agentDiagnosis?: AgentDiagnosis;
  automaticDiagnosisAttempt?: number;
  autoRecoveryCount?: number;
};
export type TaskUpdate = Omit<Task, 'productSnapshot'>;
export type AgentConfig = {
  baseUrl: string;
  model: string;
  keySaved: boolean;
  updatedAt?: string;
  autoDiagnose?: boolean;
  autoReadPage?: boolean;
  autoRecover?: boolean;
};
export type AgentConfigInput = {
  baseUrl: string;
  model: string;
  apiKey: string;
  clearKey?: boolean;
  autoDiagnose?: boolean;
  autoReadPage?: boolean;
  autoRecover?: boolean;
};
export type AgentAction = 'edit_product' | 'resume' | 'readback' | 'manual';
export type AgentProposal = { action: AgentAction; reason: string; evidence: string[] };
export type AgentDiagnosis = {
  id: string;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  model: string;
  endpoint: string;
  fingerprint: string;
  summary?: string;
  proposals?: AgentProposal[];
  error?: string;
  sources: string[];
  tokens?: number;
  pageRequested: boolean;
  trigger?: 'manual' | 'automatic';
  automaticAction?: 'resume' | 'readback';
  operations?: { name: string; ok: boolean; message: string; durationMs: number }[];
};
export type Workspace = {
  products: Product[];
  shops: Shop[];
  tasks: Task[];
  version: string;
  encryptionAvailable: boolean;
};
export type ShopInput = {
  id?: string;
  name: string;
  account: string;
  password: string;
  platform?: PlatformId;
};
export type BrowserConnectionStatus = {
  state:
    'ready' | 'extension_disconnected' | 'service_unavailable' | 'version_mismatch' | 'unsupported';
  message: string;
  httpAddress: string;
  wsAddress: string;
  serviceVersion?: string;
  extensionVersion?: string;
  suggestedCommand?: string;
};
export type UpdateFile = {
  platform: string;
  arch: string;
  url: string;
  size: number;
  sha256: string;
};
export type UpdateRelease = {
  version: string;
  notes: string;
  file: UpdateFile;
  signatureVerified?: boolean;
};
export type UpdateState = {
  status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  feedUrl: string;
  received: number;
  release?: UpdateRelease;
  message?: string;
  currentNotes?: string;
};
export interface DesktopApi {
  collectionState(): Promise<CollectionState>;
  collectShop(shopId: string): Promise<CollectionState>;
  exportShopGoods(goodsIds: string[]): Promise<CollectionState | null>;
  cancelCollection(): Promise<void>;
  showCollectionFile(): Promise<void>;
  onCollectionChanged(listener: (state: CollectionState) => void): () => void;
  exportProduct(product: Product): Promise<string | null>;
  updateState(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  openUpdateInstaller(): Promise<void>;
  onUpdateChanged(listener: (state: UpdateState) => void): () => void;
  browserConnection(): Promise<BrowserConnectionStatus>;
  exportBrowserExtension(): Promise<{ folder: string; zip: string }>;
  copyBrowserExtensionPath(): Promise<{ folder: string; zip: string }>;
  openBrowserGuide(): Promise<void>;
  openBrowserHelp(): Promise<void>;
  copyBridgeAddress(): Promise<void>;
  copyExtensionPage(browser: 'chrome' | 'edge'): Promise<void>;
  load(): Promise<Workspace>;
  importData(kind: 'excel' | 'folder' | 'example'): Promise<Product[] | null>;
  supplement(): Promise<Asset[] | null>;
  saveProducts(products: Product[]): Promise<Workspace>;
  saveShop(input: ShopInput): Promise<Workspace>;
  loginShop(input: { id: string; mode: 'relogin' | 'check' }): Promise<ShopLoginResult>;
  onShopLoginChanged(listener: (result: ShopLoginResult) => void): () => void;
  prepareTasks(input: {
    shopId: string;
    productIds: string[];
  }): Promise<{ workspace: Workspace; taskIds: string[] }>;
  runTasks(ids: string[]): Promise<Workspace>;
  resumeTask(id: string): Promise<Workspace>;
  restartTask(id: string): Promise<Workspace>;
  confirmTaskShop(id: string): Promise<Workspace>;
  updateTaskProduct(id: string): Promise<Workspace>;
  onTaskChanged(listener: (task: TaskUpdate) => void): () => void;
  stopTasks(): Promise<Workspace>;
  clearTaskRecords(ids: string[]): Promise<Workspace>;
  restoreTaskRecords(ids: string[]): Promise<Workspace>;
  openEvidence(id: string): Promise<void>;
  /** 模板按平台区分：拼多多与天猫的发品表单字段不同，不能共用一份。 */
  downloadTemplate(kind?: 'blank' | 'example', platform?: PlatformId): Promise<boolean>;
  showDataFolder(): Promise<void>;
  agentConfig(): Promise<AgentConfig>;
  saveAgentConfig(input: AgentConfigInput): Promise<AgentConfig>;
  testAgentConfig(input: AgentConfigInput): Promise<{ model: string; durationMs: number }>;
  diagnoseTask(input: { id: string; includePage: boolean }): Promise<Workspace>;
  confirmAgentAction(input: {
    id: string;
    diagnosisId: string;
    proposalIndex: number;
  }): Promise<Workspace>;
}
declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
