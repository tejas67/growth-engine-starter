declare global {
  namespace App {
    interface Locals {
      /** The signed-in founder credential, or null when nobody is signed in. */
      user: string | null;
      /** False when the password hash or session secret is missing. Fails closed. */
      credentialsConfigured: boolean;
    }
  }
}

export {};
