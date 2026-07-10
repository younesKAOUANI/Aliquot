import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';

import type { Page } from '../common/cursor';
import { ForbiddenError } from '../common/problem-details';
import type { RequestContext } from '../database/request-context';
import type { StudyRole } from '../database/schema';
import { AuthService } from '../identity/auth.service';
import { Ctx } from '../http/principal';
import { parseWith } from '../http/zod-validation';
import { DerivationService } from './derivation.service';
import type { DerivationView } from './derivation.service';
import { DEFAULT_LINEAGE_DEPTH, MAX_LINEAGE_DEPTH } from './lineage-graph';
import type { LineageGraph } from './lineage-graph';
import { LineageService } from './lineage.service';
import { toProvJson } from './prov-export';
import type { ProvDocument } from './prov-export';

/**
 * Read access to provenance.
 *
 * Everything here needs the scientist role or better: lineage is the answer to
 * "where did this result come from", which is a research question rather than an
 * operational one, and an operator credential sitting on an acquisition
 * workstation should not be able to enumerate what a study derived from its
 * uploads.
 */

const artifactParams = z.object({ artifactId: z.uuid() });
const runParams = z.object({ runId: z.uuid() });

const lineageQuery = z.object({
  direction: z.enum(['ancestors', 'descendants', 'both']).default('both'),
  /**
   * Derivation hops, not nodes. Capped rather than unbounded, and the response
   * says whether the cap hid anything -- a traversal that silently stops is
   * indistinguishable from a lineage that genuinely ends there, which is the one
   * mistake a provenance API must not make.
   */
  depth: z.coerce.number().int().min(1).max(MAX_LINEAGE_DEPTH).default(DEFAULT_LINEAGE_DEPTH),
});

const derivationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

const SCIENTIST_OR_ABOVE: StudyRole[] = ['scientist', 'steward', 'admin'];

@Controller('v1')
export class LineageController {
  constructor(
    private readonly lineage: LineageService,
    private readonly derivations: DerivationService,
    private readonly auth: AuthService,
  ) {}

  @Get('artifacts/:artifactId/lineage')
  async trace(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<LineageGraph> {
    const { artifactId } = parseWith(artifactParams, params, 'params');
    const options = parseWith(lineageQuery, query, 'query');

    await this.requireScientist(ctx, artifactId);

    return this.lineage.trace(ctx, artifactId, {
      direction: options.direction,
      maxDepth: options.depth,
    });
  }

  /**
   * The same graph as PROV-JSON.
   *
   * Served as `application/json` rather than a PROV-specific media type because
   * PROV-JSON has no registered one; the representation is identified by its
   * structure and by the `prefix` block, not by a content type nobody's client
   * will negotiate.
   */
  @Get('artifacts/:artifactId/lineage.prov.json')
  @Header('content-type', 'application/json')
  async traceAsProv(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<ProvDocument> {
    const { artifactId } = parseWith(artifactParams, params, 'params');
    const options = parseWith(lineageQuery, query, 'query');

    await this.requireScientist(ctx, artifactId);

    const graph = await this.lineage.trace(ctx, artifactId, {
      direction: options.direction,
      maxDepth: options.depth,
    });

    return toProvJson(graph);
  }

  @Get('runs/:runId/derivations')
  async derivationsForRun(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<Page<DerivationView>> {
    const { runId } = parseWith(runParams, params, 'params');
    const options = parseWith(derivationListQuery, query, 'query');

    const studyId = await this.derivations.studyOfRun(ctx, runId);
    await this.auth.requireStudyRole(ctx, studyId, SCIENTIST_OR_ABOVE);

    return this.derivations.listForRun(ctx, runId, options);
  }

  /**
   * An artifact is authorised through any study it is bound to.
   *
   * `requireStudyRole` answers one study at a time and signals refusal by
   * throwing, so asking it about several means catching. Only `ForbiddenError`
   * is absorbed, and only to ask about the next candidate -- anything else, a
   * database failure in particular, propagates untouched. Swallowing those would
   * turn an outage into a 403 and send whoever is on call looking at the
   * permissions model.
   */
  private async requireScientist(ctx: RequestContext, artifactId: string): Promise<void> {
    const studyIds = await this.lineage.studiesForArtifact(ctx, artifactId);
    let refusal: ForbiddenError | undefined;

    for (const studyId of studyIds) {
      try {
        await this.auth.requireStudyRole(ctx, studyId, SCIENTIST_OR_ABOVE);
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenError)) throw error;
        refusal = error;
      }
    }

    throw (
      refusal ??
      new ForbiddenError(
        `Reading the lineage of artifact ${artifactId} requires the scientist role in a study ` +
          'it belongs to.',
        'study:scientist',
      )
    );
  }
}
