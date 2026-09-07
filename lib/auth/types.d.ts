import { UserRole } from "./authOptions";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      roles: UserRole[];
      hostProfileId: string | null;
      adminRole: string | null;
      sessionVersion: number;
      sessionId: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
    };
  }
  interface User {
    id: string;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    roles: UserRole[];
    hostProfileId: string | null;
    adminRole: string | null;
    sessionVersion: number;
    sessionId: string;
  }
}
