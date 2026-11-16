import type { LaunchOptions } from 'puppeteer';

declare module 'puppeteer' {
  // whatsapp-web.js 1.34.8 references this missing name; keep actual launch-option checking.
  interface PuppeteerNodeLaunchOptions extends LaunchOptions {}
}
