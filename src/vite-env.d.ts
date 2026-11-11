/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_LEXEME_API?: string }

/** Exposed by the Electron preload script; absent in a plain browser. */
interface Window { lexeme?: { pickDirectory: () => Promise<string | undefined> } }
