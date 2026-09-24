'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useWorkspaceDocumentStream } from '../../lib/useWorkspaceDocumentStream';

type StatusCallback = Parameters<ReturnType<typeof useWorkspaceDocumentStream>['subscribe']>[1];

interface WorkspaceStatusContextValue {
  subscribe: (documentId: string, cb: StatusCallback) => void;
  unsubscribe: (documentId: string) => void;
}

const WorkspaceStatusContext = createContext<WorkspaceStatusContextValue>({
  subscribe: () => {},
  unsubscribe: () => {},
});

export function WorkspaceStatusProvider({
  workspaceId,
  token,
  children,
}: {
  workspaceId: string | null;
  token: string | null;
  children: ReactNode;
}) {
  const { subscribe, unsubscribe } = useWorkspaceDocumentStream(workspaceId, token);
  return (
    <WorkspaceStatusContext.Provider value={{ subscribe, unsubscribe }}>
      {children}
    </WorkspaceStatusContext.Provider>
  );
}

export function useWorkspaceStatus() {
  return useContext(WorkspaceStatusContext);
}
