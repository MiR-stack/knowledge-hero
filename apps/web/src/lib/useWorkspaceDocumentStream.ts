'use client';
import { useEffect, useRef, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type StatusCallback = (data: {
  documentId: string;
  status: string;
  progressPct: number;
  error: string | null;
}) => void;

export function useWorkspaceDocumentStream(
  workspaceId: string | null,
  token: string | null
) {
  const wsRef = useRef<WebSocket | null>(null);
  const callbacksRef = useRef(new Map<string, StatusCallback>());
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (!workspaceId || !token) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = API_URL
      .replace(/^http/, 'ws')
      .replace(/^https/, 'wss');
    
    const ws = new WebSocket(`${wsUrl}/ws/workspaces/${workspaceId}/documents?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'connected') return; // handshake
        const cb = callbacksRef.current.get(data.documentId);
        if (cb) cb(data);
      } catch {}
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Reconnect after 3 seconds on unexpected close
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error('[ws] WebSocket error:', err);
    };
  }, [workspaceId, token]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close(1000, 'unmounted');
    };
  }, [connect]);

  const subscribe = useCallback((documentId: string, cb: StatusCallback) => {
    callbacksRef.current.set(documentId, cb);
  }, []);

  const unsubscribe = useCallback((documentId: string) => {
    callbacksRef.current.delete(documentId);
  }, []);

  return { subscribe, unsubscribe };
}
