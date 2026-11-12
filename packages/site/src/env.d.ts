/// <reference types="astro/client" />
declare module '*.sprout?raw' { const src: string; export default src; }
interface ImportMetaEnv { readonly PUBLIC_RELEASES_REPO?: string }
