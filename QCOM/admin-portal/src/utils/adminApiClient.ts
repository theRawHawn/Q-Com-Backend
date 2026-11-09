import { AdminUser, AdminRole } from '../types/admin';

class AdminApiClient {
  private currentRole: AdminRole = 'SUPER_ADMIN';
  private currentId: string = 'emp-001';
  private currentPersona: AdminUser | null = null;
  private sessionToken: string | null = null;

  constructor() {
    // Attempt to load cached session from localStorage if available
    try {
      const savedToken = localStorage.getItem('qcom_admin_session_token');
      if (savedToken) this.sessionToken = savedToken;
      const savedRole = localStorage.getItem('qcom_admin_role');
      if (savedRole) this.currentRole = savedRole as AdminRole;
      const savedId = localStorage.getItem('qcom_admin_id');
      if (savedId) this.currentId = savedId;
    } catch {
      // Ignore SSR/localStorage restrictions
    }
  }

  setAdminRole(role: AdminRole) {
    this.currentRole = role;
    try {
      localStorage.setItem('qcom_admin_role', role);
    } catch {}
  }

  setAdminId(id: string) {
    this.currentId = id;
    try {
      localStorage.setItem('qcom_admin_id', id);
    } catch {}
  }

  setPersona(persona: AdminUser) {
    this.currentPersona = persona;
    this.currentRole = persona.role;
    this.currentId = persona.id;
    try {
      localStorage.setItem('qcom_admin_role', persona.role);
      localStorage.setItem('qcom_admin_id', persona.id);
    } catch {}
  }

  getCurrentPersona(): AdminUser | null {
    return this.currentPersona;
  }

  getCurrentRole(): AdminRole {
    return this.currentRole;
  }

  setSessionToken(token: string) {
    this.sessionToken = token;
    try {
      localStorage.setItem('qcom_admin_session_token', token);
    } catch {}
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-admin-role': this.currentRole,
      'x-admin-id': this.currentId,
    };
    if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
      headers['x-admin-session-token'] = this.sessionToken;
    }
    return headers;
  }

  async get<T = any>(url: string): Promise<T> {
    const res = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errBody.error || errBody.message || `Request failed with status ${res.status}`);
    }
    return res.json();
  }

  async post<T = any>(url: string, body?: any): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errBody.error || errBody.message || `Request failed with status ${res.status}`);
    }
    return res.json();
  }

  async put<T = any>(url: string, body?: any): Promise<T> {
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errBody.error || errBody.message || `Request failed with status ${res.status}`);
    }
    return res.json();
  }

  async delete<T = any>(url: string): Promise<T> {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errBody.error || errBody.message || `Request failed with status ${res.status}`);
    }
    return res.json();
  }
}

export const adminApi = new AdminApiClient();
