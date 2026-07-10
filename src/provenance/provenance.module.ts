import { Module } from '@nestjs/common';

import { DerivationService } from './derivation.service';
import { LineageController } from './lineage.controller';
import { LineageService } from './lineage.service';

/**
 * The provenance module.
 *
 * `DerivationService` is exported because the worker records derivations inside
 * the transaction that writes their outputs, not by calling an endpoint here.
 * That is the whole point of the seam: a derivation that committed separately
 * from the artifacts it describes would be a dual write, and the crash between
 * the two is the case the unique constraint exists to make survivable.
 *
 * `DatabaseService`, `AppConfig` and `AuthService` are not provided here. They
 * are process-wide singletons owned by the root composition; re-providing them
 * in a feature module would mean a second connection pool.
 */
@Module({
  controllers: [LineageController],
  providers: [DerivationService, LineageService],
  exports: [DerivationService, LineageService],
})
export class ProvenanceModule {}
