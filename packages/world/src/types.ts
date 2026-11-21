import type { Pool, PoolClient } from 'pg';

export type OfficialSystemType = 'religion' | 'ideology';
export type StartBuildingType =
  | 'factory'
  | 'field'
  | 'gold_mine'
  | 'capital'
  | 'religious_building'
  | 'science'
  | 'barracks'
  | 'tower';

export interface StartBuildingPlacement {
  readonly type: StartBuildingType;
  /** Horizontal offset inside the 5x5 territory, from 0 through 4. */
  readonly x: number;
  /** Vertical offset inside the 5x5 territory, from 0 through 4. */
  readonly y: number;
}

export interface OfficialSystemChoice {
  readonly type: OfficialSystemType;
  readonly existingSystemId?: string;
  readonly newSystemName?: string;
}

export interface CreateCountryInput {
  readonly name: unknown;
  /** Center X coordinate of the 5x5 starting territory. */
  readonly spawnX: number;
  /** Center Y coordinate of the 5x5 starting territory. */
  readonly spawnY: number;
  readonly officialSystem: OfficialSystemChoice;
  readonly buildings: ReadonlyArray<StartBuildingPlacement>;
}

export interface AvailableSocialSystem {
  readonly id: string;
  readonly type: OfficialSystemType;
  readonly name: string;
  readonly originX: number;
  readonly originY: number;
}

export interface SocialSystemAvailabilityQuery {
  readonly campaignId: string;
  readonly systemType: OfficialSystemType;
  readonly spawnX: number;
  readonly spawnY: number;
}

export interface SocialSystemAvailabilityPolicy {
  /**
   * Must apply the current ruleset's geographic accessibility parameters and
   * return eligible systems sorted by proximity. This package does not invent
   * a default radius or distance metric.
   */
  listAvailable(
    tx: PoolClient,
    query: SocialSystemAvailabilityQuery,
  ): Promise<readonly AvailableSocialSystem[]>;
}

export interface CountrySetupOptions {
  readonly pool: Pool;
  readonly systemAvailabilityPolicy?: SocialSystemAvailabilityPolicy;
}

export interface CreatedCountry {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string;
  readonly officialSystem: AvailableSocialSystem;
  readonly territory: {
    readonly centerX: number;
    readonly centerY: number;
    readonly width: 5;
    readonly height: 5;
  };
  readonly buildingCount: 7;
  readonly residentCount: 18;
  readonly snapshotVersion: number;
}

export interface CountrySetupService {
  listAvailableSystems(
    userId: string,
    campaignId: string,
    systemType: OfficialSystemType,
    spawnX: number,
    spawnY: number,
  ): Promise<readonly AvailableSocialSystem[]>;
  createCountry(
    userId: string,
    campaignId: string,
    input: CreateCountryInput,
  ): Promise<CreatedCountry>;
}
