import {accountStorageKey} from './persistence';
// AI 运行配置：模型服务 + 联网搜索。设置页可改，存 localStorage 即时生效；不上传任何服务器。
export interface AiConfig {
  llm: { baseUrl: string; apiKey: string; model: string };
  search: { enabled: boolean; baseUrl: string; apiKey: string; model: string };
  /** OXR 文档解析（扫描件/复杂版面）：SoMark 免费 API，无需真实 key */
  oxr: { enabled: boolean; baseUrl: string; apiKey: string };
}

const LS_KEY = 'rfq-ai-config-v3';

const defaults = (): AiConfig => ({
  llm: {
    baseUrl: '/llm', // vite 代理 → MOI Genesis（生产由后端代理）
    apiKey: '', // Model credentials are injected only by the server-side proxy.
    model: import.meta.env.VITE_LLM_MODEL ?? 'DeepSeek-V4.1-Flash',
  },
  search: {
    enabled: false,
    baseUrl: '/wsa', // vite 代理 → 元宝搜索 WSA（SearchPro，无需模型字段）
    apiKey: '',
    model: '',
  },
  oxr: {
    enabled: true, // 扫描件 PDF 解析；免费 API 无需注册（api_key=dummy）
    baseUrl: '/oxr',
    apiKey: 'dummy',
  },
});

export function getAiConfig(): AiConfig {
  const d = defaults();
  try {
    const raw = localStorage.getItem(accountStorageKey(LS_KEY));
    if (!raw) return d;
    const saved = JSON.parse(raw) as Partial<AiConfig>;
    return {
      llm: { ...d.llm, ...saved.llm },
      search: { ...d.search, ...saved.search },
      oxr: { ...d.oxr, ...saved.oxr },
    };
  } catch {
    return d;
  }
}

export function saveAiConfig(cfg: AiConfig): void {
  localStorage.setItem(accountStorageKey(LS_KEY), JSON.stringify(cfg));
}

export function resetAiConfig(): void {
  localStorage.removeItem(accountStorageKey(LS_KEY));
}
