/** WP0 interface stub — LocalPasswordAuthProvider lands in WP3. */

export type AppUser = {
  id: string;
  email: string;
  role: "admin" | "tech_lead" | "developer";
  status: "active" | "deactivated";
};

export interface AppAuthProvider {
  verifyLocalLogin(email: string, password: string): Promise<AppUser>;
  // Future (not M1): beginSso / handleSsoCallback
}

export const PACKAGE_NAME = "@reviewpulse/app-auth" as const;
