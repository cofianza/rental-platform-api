// ============================================================
// Provider Factory — selects mock or real based on config
// ============================================================

import { env } from '@/config';
import { logger } from '@/lib/logger';
import type { CreditRiskProvider, ProveedorId } from './types';
import { MockProvider } from './mock.provider';
import { TransUnionProvider } from './transunion.provider';
import { SifinProvider } from './sifin.provider';
import { DatacreditoProvider } from './datacredito.provider';

const ALL_PROVIDER_IDS: ProveedorId[] = ['transunion', 'sifin', 'datacredito'];

const providerInstances = new Map<ProveedorId, CreditRiskProvider>();

function createProvider(id: ProveedorId): CreditRiskProvider {
  if (env.CREDIT_PROVIDER_USE_MOCK) {
    logger.info({ provider: id }, 'Using MOCK credit risk provider');
    return new MockProvider(id);
  }

  switch (id) {
    case 'transunion':
      return new TransUnionProvider();
    case 'sifin':
      return new SifinProvider();
    case 'datacredito':
      return new DatacreditoProvider();
    default:
      throw new Error(`Proveedor de riesgo desconocido: ${id}`);
  }
}

export function getProvider(id: ProveedorId): CreditRiskProvider {
  let provider = providerInstances.get(id);
  if (!provider) {
    provider = createProvider(id);
    providerInstances.set(id, provider);
  }
  return provider;
}

export function getAllProviderIds(): ProveedorId[] {
  return ALL_PROVIDER_IDS;
}
