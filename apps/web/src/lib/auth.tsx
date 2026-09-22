"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UserRole } from "@rag/shared-types";
import { fetchWorkspaces, login as apiLogin, signup as apiSignup } from "./api";

const STORAGE_KEY = "rag-auth";

interface AuthState {
  token: string;
  userId: string;
  email: string;
  fullName: string;
  workspaceId: string;
  role: UserRole;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  signup: (input: {
    email: string;
    password: string;
    fullName: string;
    workspaceName: string;
  }) => Promise<void>;
  switchWorkspace: (workspaceId: string) => void;
  logout: () => void;
  isReady: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadStoredAuth(): AuthState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

function persistAuth(state: AuthState | null) {
  if (typeof window === "undefined") return;
  if (state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setAuth(loadStoredAuth());
    setIsReady(true);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email, password);
    const membership = res.memberships[0];
    if (!membership) throw new Error("No workspace membership found");

    const next: AuthState = {
      token: res.accessToken,
      userId: res.user.id,
      email: res.user.email,
      fullName: res.user.fullName,
      workspaceId: membership.workspaceId,
      role: membership.role,
    };
    persistAuth(next);
    setAuth(next);
  }, []);

  const signup = useCallback(
    async (input: {
      email: string;
      password: string;
      fullName: string;
      workspaceName: string;
    }) => {
      const res = await apiSignup(input);
      const next: AuthState = {
        token: res.accessToken,
        userId: res.user.id,
        email: res.user.email,
        fullName: res.user.fullName,
        workspaceId: res.workspace.id,
        role: "workspace_admin",
      };
      persistAuth(next);
      setAuth(next);
    },
    [],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      if (!auth?.token) return;
      fetchWorkspaces(auth.token)
        .then((res) => {
          const ws = res.workspaces.find((w) => w.id === workspaceId);
          if (!ws) return;
          const next: AuthState = {
            ...auth,
            workspaceId: ws.id,
            role: ws.role,
          };
          persistAuth(next);
          setAuth(next);
        })
        .catch(() => {});
    },
    [auth],
  );

  const logout = useCallback(() => {
    persistAuth(null);
    setAuth(null);
  }, []);

  const value = useMemo(
    () =>
      auth
        ? { ...auth, login, signup, switchWorkspace, logout, isReady }
        : ({
            token: "",
            userId: "",
            email: "",
            fullName: "",
            workspaceId: "",
            role: "staff_member" as UserRole,
            login,
            signup,
            switchWorkspace,
            logout,
            isReady,
          } satisfies AuthContextValue),
    [auth, login, signup, switchWorkspace, logout, isReady],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function useRequireAuth(): AuthState & {
  login: AuthContextValue["login"];
  logout: AuthContextValue["logout"];
  switchWorkspace: AuthContextValue["switchWorkspace"];
} {
  const auth = useAuth();
  if (!auth.token) {
    throw new Error("Authentication required");
  }
  return auth as AuthState & {
    login: AuthContextValue["login"];
    logout: AuthContextValue["logout"];
    switchWorkspace: AuthContextValue["switchWorkspace"];
  };
}
