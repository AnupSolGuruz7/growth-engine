/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GROWTHOS_SITE_ID: string;
  readonly VITE_GROWTHOS_ENDPOINT: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
