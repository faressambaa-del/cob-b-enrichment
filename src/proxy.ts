import { BrowserContextOptions, ProxyOptions } from 'playwright';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export function parseProxyUrl(proxyUrl: string): ProxyConfig {
  try {
    const url = new URL(proxyUrl);
    return {
      server: `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, ''),
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch (e) {
    console.warn(`Invalid proxy URL format: ${proxyUrl}`);
    return { server: proxyUrl };
  }
}

export class ProxyRotator {
  private proxies: ProxyConfig[] = [];
  private index = 0;

  constructor(proxyUrls: string[]) {
    this.proxies = proxyUrls
      .filter(Boolean)
      .map(parseProxyUrl);
    console.log(`🌐 Loaded ${this.proxies.length} proxy(s) for rotation`);
  }

  getNext(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    const proxy = this.proxies[this.index];
    this.index = (this.index + 1) % this.proxies.length;
    return proxy;
  }

  getBrowserContextOptions(): BrowserContextOptions | undefined {
    const proxy = this.getNext();
    if (!proxy) return undefined;
    
    const playwrightProxy: ProxyOptions = {
      server:
