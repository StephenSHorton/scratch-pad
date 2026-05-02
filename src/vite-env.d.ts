/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_AIZUCHI_PROVIDER?: string;
	readonly VITE_AIZUCHI_OLLAMA_MODEL?: string;
	readonly VITE_OLLAMA_BASE_URL?: string;
	readonly VITE_ANTHROPIC_API_KEY?: string;
	readonly VITE_AIZUCHI_ANTHROPIC_MODEL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
