import { AppError } from '../utils/errors.js';
import type {
  ProxyResult,
  RouteDecision,
  RouteRequest,
  UpstreamErrorLike,
} from '../types/routing.js';
import { KeyPool } from './keyPool.js';
import { OrgQueueManager } from './orgQueue.js';
import { RouterEngine } from './routerEngine.js';

export interface RouteExecutionInput {
  request: RouteRequest;
  runUpstream: (decision: RouteDecision) => Promise<{
    upstreamStatus: number;
    data: unknown;
    usageUnits?: number;
    contentType?: string;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKeySpecific(kind: UpstreamErrorLike['kind'], keySpecific?: boolean): boolean {
  if (typeof keySpecific === 'boolean') return keySpecific;
  return kind === 'auth' || kind === 'permission';
}

export class RoutingService {
  constructor(
    private readonly pool: KeyPool,
    private readonly router: RouterEngine,
    private readonly queue: OrgQueueManager,
  ) {}

  async execute(input: RouteExecutionInput): Promise<ProxyResult> {
    const { request, runUpstream } = input;

    return await this.queue.run(request.orgId, async () => {
      const tried = new Set<string>();
      const maxAttempts = 3;

      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
        const candidates = this.pool.getCandidates(request.provider, request.model, request.streaming);
        const key = this.router.pickWeightedRoundRobin({
          orgId: request.orgId,
          provider: request.provider,
          model: request.model,
          candidates,
          excludeKeyIds: tried,
        });

        if (!key) {
          throw new AppError('capacity_unavailable', 429, 'No eligible seller keys available', {
            provider: request.provider,
            model: request.model,
          });
        }

        const decision: RouteDecision = {
          sellerKeyId: key.id,
          attemptNo,
          reason: 'weighted_round_robin',
        };

        tried.add(key.id);

        try {
          const result = await runUpstream(decision);
          if (result.usageUnits && result.usageUnits > 0) {
            this.pool.addCapacityUsage(key.id, result.usageUnits);
          }
          return {
            requestId: request.requestId,
            keyId: key.id,
            attemptNo,
            upstreamStatus: result.upstreamStatus,
            usageUnits: result.usageUnits,
            contentType: result.contentType,
            data: result.data,
          };
        } catch (rawErr) {
          const err = rawErr as UpstreamErrorLike;
          const kind = err.kind ?? 'other';

          if (kind === 'rate_limited') {
            const backoffMs = 200 * (2 ** (attemptNo - 1));
            const jitterMs = Math.floor(Math.random() * 100);
            await sleep(backoffMs + jitterMs);
            continue;
          }

          if (kind === 'server_error' || kind === 'network') {
            continue;
          }

          if (kind === 'auth' || kind === 'permission' || kind === 'model_invalid') {
            if (isKeySpecific(kind, err.keySpecific)) continue;
            throw new AppError('upstream_non_retryable', 502, err.message || 'Upstream rejected request');
          }

          throw new AppError('upstream_error', 502, err.message || 'Upstream request failed');
        }
      }

      throw new AppError('capacity_unavailable', 429, 'All retry/failover attempts exhausted');
    });
  }
}
