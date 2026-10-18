import type { AllaiApi } from '@shared/ipc';

declare global {
  interface Window {
    allai: AllaiApi;
  }
}

export {};
