'use client';
import { useEffect, useState, useRef } from 'react';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface DocumentStatusState {
  status: ProcessingStatus;
  progressPct: number;
  error: string | null;
  isTerminal: boolean;
}

type ProcessingStatus = 'queued' | 'extracting' | 'chunking' | 'embedding' | 'indexed' | 'failed';

export function useDocumentStatus(
  documentId: string | null,
  token: string | null,
  workspaceId: string | null,
  initialStatus?: ProcessingStatus
): DocumentStatusState {
  const [state, setState] = useState<DocumentStatusState>({
    status: initialStatus ?? 'queued',
    progressPct: 0,
    error: null,
    isTerminal: initialStatus === 'indexed' || initialStatus === 'failed',
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!documentId || !token || !workspaceId) return;
    // Don't connect if already in terminal state
    if (initialStatus === 'indexed' || initialStatus === 'failed') return;

    const url = new URL(`${API_URL}/api/v1/documents/${documentId}/events`);
    // EventSource doesn't support custom headers in browser — pass credentials via headers
    // We use a wrapper approach: actually EventSource only supports URL params for auth workaround.
    // Since SSE endpoint reads Bearer from Authorization header, we use a polyfill approach.
    // For now, use a fetch-based SSE reader instead of native EventSource to allow headers.
    
    let closed = false;
    
    async function connectSSE() {
      const res = await fetch(
        `${API_URL}/api/v1/documents/${documentId}/events`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Workspace-Id': workspaceId!,
            'Accept': 'text/event-stream',
          },
        }
      );

      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        // Parse SSE events from buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        
        for (const event of events) {
          if (!event.trim()) continue;
          const lines = event.split('\n');
          let eventName = 'message';
          let dataStr = '';
          
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) dataStr = line.slice(5).trim();
          }
          
          if (!dataStr) continue;
          
          try {
            const data = JSON.parse(dataStr);
            const isTerminal = data.status === 'indexed' || data.status === 'failed';
            setState({
              status: data.status as ProcessingStatus,
              progressPct: data.progressPct ?? 0,
              error: data.error ?? null,
              isTerminal,
            });
            if (isTerminal) {
              closed = true;
              reader.cancel();
              return;
            }
          } catch {}
        }
      }
    }

    connectSSE().catch(console.error);

    return () => {
      closed = true;
    };
  }, [documentId, token, workspaceId, initialStatus]);

  return state;
}
