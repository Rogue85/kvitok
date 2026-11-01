declare module '#app' {
  interface PageMeta {
    /** The page is available without signing in. */
    public?: boolean;
    /** A public page that a signed-in user can open too, instead of being sent to their workspace. */
    keepSession?: boolean;
    /** Installation management: superadmins only. */
    superadmin?: boolean;
  }
}

export {};
