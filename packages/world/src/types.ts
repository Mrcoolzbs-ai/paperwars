import type { Pool, PoolClient } from 'pg';

export type OfficialSystemType = 'religion' | 'ideology';
export type SocialSystemPolarity = 'positive' | 'negative' | 'neutral';
export type SocialSystemApprovalStatus = 'pending' | 'approved' | 'rejected';
export type SocialSystemReviewDecision = 'approve' | 'reject';
export type StartBuildingType =
  | 'factory'
  | 'field'
  | 'gold_mine'
  | 'capital'
  | 'religious_building'
  | 'science'
  | 'barracks'
  | 'tower';

export interface SocialSystemPrinciple {
  readonly name: string;
  readonly description: string;
  readonly effect?: string;
  readonly polarity: SocialSystemPolarity;
}

export interface CreateSocialSystemInput {
  readonly type: unknown;
  readonly name: unknown;
  readonly principles: unknown;
  readonly emblemDataUrl?: unknown;
}

export interface SocialSystemReviewInput {
  readonly decision: unknown;
  readonly reason?: unknown;
}

export interface PlayerSocialSystemTemplateView {
  readonly id: string;
  readonly type: OfficialSystemType;
  readonly name: string;
  readonly principles: readonly SocialSystemPrinciple[];
  readonly emblemDataUrl: string | null;
  readonly sourceCampaignId: string | null;
  readonly updatedAt: Date;
}

export interface CountryProfileView {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string;
  readonly culture: readonly string[];
  readonly government: string;
  readonly flagDataUrl: string | null;
  readonly officialSystem: {
    readonly id: string;
    readonly type: OfficialSystemType;
    readonly name: string;
    readonly principles: readonly SocialSystemPrinciple[];
    readonly emblemDataUrl: string | null;
  };
  readonly territory: {
    readonly centerX: number | null;
    readonly centerY: number | null;
    readonly width: 5;
    readonly height: 5;
  };
  readonly buildings: readonly { readonly type: StartBuildingType; readonly count: number }[];
  readonly residentCount: number;
}

export interface SocialSystemView {
  readonly id: string;
  readonly campaignId: string;
  readonly type: OfficialSystemType;
  readonly name: string;
  readonly principles: readonly SocialSystemPrinciple[];
  readonly emblemDataUrl: string | null;
  readonly approvalStatus: SocialSystemApprovalStatus;
  readonly reviewReason: string | null;
  readonly createdAt: Date;
}

export interface StartBuildingPlacement {
  readonly type: StartBuildingType;
  /** Horizontal offset inside the 5x5 territory, from 0 through 4. */
  readonly x: number;
  /** Vertical offset inside the 5x5 territory, from 0 through 4. */
  readonly y: number;
}

export type AdditionalBuildingType =
  'factory' | 'field' | 'religious_building' | 'science' | 'barracks' | 'tower';

export interface BuildBuildingInput {
  readonly buildingType: unknown;
  /** Zero-based X offset within the owned 5x5 territory. */
  readonly x: unknown;
  /** Zero-based Y offset within the owned 5x5 territory. */
  readonly y: unknown;
}

export interface BuiltBuilding {
  readonly id: string;
  readonly type: AdditionalBuildingType;
  readonly x: number;
  readonly y: number;
  readonly remainingResidents: number;
  readonly snapshotVersion: number;
}

export interface CreateCountryInput {
  readonly name: unknown;
  /** Center X coordinate of the 5x5 starting territory. */
  readonly spawnX: number;
  /** Center Y coordinate of the 5x5 starting territory. */
  readonly spawnY: number;
  /** ID of a previously created and administrator-approved system. */
  readonly officialSystemId: unknown;
  readonly buildings: ReadonlyArray<StartBuildingPlacement>;
  readonly culture?: unknown;
  readonly government?: unknown;
  readonly flagDataUrl?: unknown;
}

export interface AvailableSocialSystem {
  readonly id: string;
  readonly type: OfficialSystemType;
  readonly name: string;
  readonly originX: number | null;
  readonly originY: number | null;
  readonly principles: readonly SocialSystemPrinciple[];
  readonly emblemDataUrl?: string | null;
}

export interface CampaignMapCountry {
  readonly id: string;
  readonly name: string;
  /** True only for the country owned by the requesting active member. */
  readonly isMine: boolean;
  readonly flagDataUrl: string | null;
  /** Fixed, independently stored borders for the core territory and every colony. */
  readonly territories: ReadonlyArray<{
    readonly id: string;
    readonly type: 'core' | 'colony';
    readonly centerX: number;
    readonly centerY: number;
    readonly width: number;
    readonly height: number;
  }>;
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly population: number;
    readonly buildingType: StartBuildingType | null;
  }>;
}

export interface CampaignSpawnReservation {
  readonly centerX: number;
  readonly centerY: number;
  readonly isMine: boolean;
}

export interface AccessibleDiscoveryView {
  readonly id: string;
  readonly type: 'ruins' | 'gold' | 'empty';
  readonly x: number;
  readonly y: number;
  readonly discoveredAtTurn: number;
  /** Visible only to administrators. */
  readonly d100?: number | null;
}

export interface CampaignMapView {
  readonly width: number;
  readonly height: number;
  readonly seed: string;
  /** Row-major l/w/r terrain encoding produced by the shared seeded generator. */
  readonly terrain: string;
  readonly countries: readonly CampaignMapCountry[];
  readonly reservations: readonly CampaignSpawnReservation[];
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
  /** Global administrator user IDs allowed to approve/reject submitted systems. */
  readonly socialSystemAdminUserIds?: readonly string[];
}

export interface CreatedCountry {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string;
  readonly culture: readonly string[];
  readonly government: string;
  readonly flagDataUrl: string | null;
  readonly officialSystem: AvailableSocialSystem;
  readonly territory: {
    readonly centerX: number;
    readonly centerY: number;
    readonly width: 5;
    readonly height: 5;
  };
  readonly buildingCount: 7;
  readonly residentCount: number;
  readonly snapshotVersion: number;
}

export interface CountrySetupService {
  getCampaignMap(userId: string, campaignId: string): Promise<CampaignMapView>;
  listAccessibleDiscoveries(
    userId: string,
    campaignId: string,
  ): Promise<readonly AccessibleDiscoveryView[]>;
  reserveSpawn(
    userId: string,
    campaignId: string,
    centerX: number,
    centerY: number,
  ): Promise<CampaignSpawnReservation>;
  createSocialSystem(
    userId: string,
    campaignId: string,
    input: CreateSocialSystemInput,
  ): Promise<SocialSystemView>;
  listMySocialSystems(userId: string, campaignId: string): Promise<readonly SocialSystemView[]>;
  listMySocialSystemLibrary(userId: string): Promise<readonly PlayerSocialSystemTemplateView[]>;
  getMyCountry(userId: string, campaignId: string): Promise<CountryProfileView | null>;
  getCountryProfileForAdmin(adminUserId: string, campaignId: string, countryId: string): Promise<CountryProfileView | null>;
  deleteBuildingForAdmin(adminUserId: string, campaignId: string, x: number, y: number): Promise<void>;
  deleteColonyForAdmin(adminUserId: string, campaignId: string, territoryId: string): Promise<void>;
  listPendingSocialSystems(
    adminUserId: string,
    campaignId: string,
  ): Promise<readonly SocialSystemView[]>;
  reviewSocialSystem(
    adminUserId: string,
    campaignId: string,
    systemId: string,
    input: SocialSystemReviewInput,
  ): Promise<SocialSystemView>;
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
  buildBuilding(
    userId: string,
    campaignId: string,
    input: BuildBuildingInput,
  ): Promise<BuiltBuilding>;
}
