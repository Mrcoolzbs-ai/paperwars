import type { Pool } from 'pg';
import {
  CampaignTurnProcessingError,
  closeOrders,
  type ClosedTurnJob,
} from '@paper-wars/persistence';

export interface AdminOverview {
  readonly users: readonly Record<string, unknown>[];
  readonly campaigns: readonly Record<string, unknown>[];
  readonly totals: Record<string, unknown>;
}

export interface AdminCampaignDetail {
  readonly campaign: Record<string, unknown>;
  readonly members: readonly Record<string, unknown>[];
  readonly countries: readonly Record<string, unknown>[];
  readonly socialSystems: readonly Record<string, unknown>[];
  readonly orders: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly discoveries: readonly Record<string, unknown>[];
  readonly discoveryHistory: readonly Record<string, unknown>[];
  readonly discoveryAccess: readonly Record<string, unknown>[];
  readonly economicReports: readonly Record<string, unknown>[];
  readonly battleReports: readonly Record<string, unknown>[];
  readonly snapshots: readonly Record<string, unknown>[];
  readonly latestSnapshot: Record<string, unknown> | null;
  readonly turnJobs: readonly Record<string, unknown>[];
  readonly randomDraws: readonly Record<string, unknown>[];
  readonly seedCommitments: readonly Record<string, unknown>[];
  readonly auditLogs: readonly Record<string, unknown>[];
}

export interface AdminService {
  getOverview(): Promise<AdminOverview>;
  getCampaignDetail(campaignId: string): Promise<AdminCampaignDetail>;
  forceCloseTurn(
    actorUserId: string,
    campaignId: string,
    expectedTurnNumber: number,
  ): Promise<ClosedTurnJob>;
}

export interface AdminServiceOptions {
  readonly pool: Pool;
}

export function createAdminService(options: AdminServiceOptions): AdminService {
  const pool = options.pool;

  return {
    async getOverview() {
      const [users, campaigns, totals] = await Promise.all([
        pool.query<Record<string, unknown>>(
          `SELECT
             user_row.id,
             user_row.email,
             user_row.status,
             user_row.created_at AS "createdAt",
             (SELECT count(*)::int
              FROM campaign_memberships AS membership
              WHERE membership.user_id = user_row.id) AS "campaignMembershipCount",
             (SELECT count(*)::int
              FROM countries AS country
              WHERE country.owner_user_id = user_row.id) AS "countryCount"
           FROM users AS user_row
           ORDER BY user_row.created_at DESC, user_row.id`,
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             campaign.id,
             campaign.name,
             campaign.status,
             campaign.current_turn AS "currentTurn",
             campaign.orders_locked AS "ordersLocked",
             campaign.deadline_at AS "deadlineAt",
             campaign.created_at AS "createdAt",
             campaign.completed_at AS "completedAt",
             campaign.map_width AS "mapWidth",
             campaign.map_height AS "mapHeight",
             campaign.map_seed AS "mapSeed",
             campaign.turn_duration_hours AS "turnDurationHours",
             (SELECT count(*)::int
              FROM campaign_memberships AS membership
              WHERE membership.campaign_id = campaign.id
                AND membership.status = 'active') AS "activeMemberCount",
             (SELECT count(*)::int
              FROM countries AS country
              WHERE country.campaign_id = campaign.id) AS "countryCount",
             (SELECT count(*)::int
              FROM orders AS order_row
              WHERE order_row.campaign_id = campaign.id
                AND order_row.turn_number = campaign.current_turn
                AND order_row.status = 'confirmed') AS "confirmedOrderCount",
             (SELECT count(*)::int
              FROM orders AS order_row
              WHERE order_row.campaign_id = campaign.id
                AND order_row.turn_number = campaign.current_turn
                AND order_row.status IN ('draft', 'unconfirmed')) AS "unconfirmedOrderCount",
             (SELECT job.status
              FROM turn_jobs AS job
              WHERE job.campaign_id = campaign.id
              ORDER BY job.turn_number DESC
              LIMIT 1) AS "latestTurnJobStatus"
           FROM campaigns AS campaign
           ORDER BY campaign.created_at DESC, campaign.id`,
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             (SELECT count(*)::int FROM users) AS "userCount",
             (SELECT count(*)::int FROM users WHERE status = 'active') AS "activeUserCount",
             (SELECT count(*)::int FROM campaigns) AS "campaignCount",
             (SELECT count(*)::int FROM campaigns WHERE status = 'active') AS "activeCampaignCount",
             (SELECT count(*)::int FROM turn_jobs WHERE status IN ('pending', 'processing')) AS "queuedTurnJobCount"`,
        ),
      ]);

      return {
        users: users.rows,
        campaigns: campaigns.rows,
        totals: totals.rows[0] ?? {},
      };
    },

    async getCampaignDetail(campaignId) {
      const campaignResult = await pool.query<Record<string, unknown>>(
        `SELECT
           id, name, status, current_turn AS "currentTurn",
           orders_locked AS "ordersLocked", orders_locked_at AS "ordersLockedAt",
           deadline_at AS "deadlineAt", ruleset_version AS "rulesetVersion",
           rng_version AS "rngVersion", map_width AS "mapWidth",
           map_height AS "mapHeight", map_seed AS "mapSeed",
           turn_duration_hours AS "turnDurationHours",
           created_at AS "createdAt", completed_at AS "completedAt"
         FROM campaigns
         WHERE id = $1`,
        [campaignId],
      );
      const campaign = campaignResult.rows[0];
      if (campaign === undefined) {
        throw new CampaignTurnProcessingError('CAMPAIGN_NOT_FOUND', 'Campaign does not exist');
      }

      const [
        members,
        countries,
        socialSystems,
        orders,
        events,
        discoveries,
        discoveryHistory,
        discoveryAccess,
        economicReports,
        battleReports,
        snapshots,
        latestSnapshot,
        turnJobs,
        randomDraws,
        seedCommitments,
        auditLogs,
      ] = await Promise.all([
        pool.query<Record<string, unknown>>(
          `SELECT
             membership.user_id AS "userId", user_row.email,
             user_row.status AS "userStatus", user_row.created_at AS "userCreatedAt",
             membership.status AS "membershipStatus",
             membership.orders_confirmed AS "ordersConfirmed",
             membership.joined_at AS "joinedAt",
             country.id AS "countryId", country.name AS "countryName",
             country.status AS "countryStatus"
           FROM campaign_memberships AS membership
           JOIN users AS user_row ON user_row.id = membership.user_id
           LEFT JOIN countries AS country
             ON country.campaign_id = membership.campaign_id
            AND country.id = membership.country_id
           WHERE membership.campaign_id = $1
           ORDER BY membership.joined_at, user_row.email`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             country.id, country.owner_user_id AS "ownerUserId",
             user_row.email AS "ownerEmail", country.name, country.status,
             country.culture, country.government,
             country.flag_data_url AS "flagDataUrl",
             country.official_system_type AS "officialSystemType",
             country.official_system_id AS "officialSystemId",
             system_row.name AS "officialSystemName",
             country.setup_completed AS "setupCompleted",
             country.created_at AS "createdAt"
           FROM countries AS country
           JOIN users AS user_row ON user_row.id = country.owner_user_id
           LEFT JOIN social_systems AS system_row
             ON system_row.campaign_id = country.campaign_id
            AND system_row.id = country.official_system_id
           WHERE country.campaign_id = $1
           ORDER BY country.created_at, country.id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             system_row.id, system_row.system_type AS "type", system_row.name,
             system_row.origin_x AS "originX", system_row.origin_y AS "originY",
             system_row.traits, system_row.principles,
             system_row.created_by_user_id AS "createdByUserId",
             creator.email AS "createdByEmail",
             system_row.approval_status AS "approvalStatus",
             system_row.reviewed_by_user_id AS "reviewedByUserId",
             reviewer.email AS "reviewedByEmail",
             system_row.reviewed_at AS "reviewedAt",
             system_row.review_reason AS "reviewReason",
             system_row.creation_kind AS "creationKind",
             system_row.lifecycle_status AS "lifecycleStatus",
             system_row.created_at AS "createdAt"
           FROM social_systems AS system_row
           LEFT JOIN users AS creator ON creator.id = system_row.created_by_user_id
           LEFT JOIN users AS reviewer ON reviewer.id = system_row.reviewed_by_user_id
           WHERE system_row.campaign_id = $1
           ORDER BY system_row.created_at, system_row.id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             order_row.id, order_row.country_id AS "countryId",
             country.name AS "countryName", country.owner_user_id AS "ownerUserId",
             user_row.email AS "ownerEmail",
             order_row.turn_number AS "turnNumber",
             order_row.order_type AS "type",
             order_row.schema_version AS "schemaVersion",
             order_row.payload, order_row.status,
             order_row.resolution_status AS "resolutionStatus",
             order_row.result_code AS "resultCode",
             order_row.result_message AS "resultMessage",
             order_row.result_data AS "resultData",
             order_row.created_at AS "createdAt",
             order_row.updated_at AS "updatedAt",
             order_row.finalized_at AS "finalizedAt"
           FROM orders AS order_row
           JOIN countries AS country
             ON country.campaign_id = order_row.campaign_id
            AND country.id = order_row.country_id
           JOIN users AS user_row ON user_row.id = country.owner_user_id
           WHERE order_row.campaign_id = $1
           ORDER BY order_row.turn_number DESC, order_row.created_at DESC, order_row.id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             event_row.id, event_row.turn_number AS "turnNumber",
             event_row.schema_version AS "schemaVersion",
             event_row.event_type AS "type", event_row.payload,
             event_row.visibility,
             event_row.recipient_country_id AS "recipientCountryId",
             recipient.name AS "recipientCountryName",
             event_row.created_at AS "createdAt"
           FROM game_events AS event_row
           LEFT JOIN countries AS recipient
             ON recipient.campaign_id = event_row.campaign_id
            AND recipient.id = event_row.recipient_country_id
           WHERE event_row.campaign_id = $1
           ORDER BY event_row.turn_number DESC, event_row.created_at DESC, event_row.id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             discovery.id, discovery.discovery_type AS "type",
             cell.x, cell.y,
             discovery.discovered_by_country_id AS "discoveredByCountryId",
             discoverer.name AS "discoveredByCountryName",
             discovery.discovered_at_turn AS "discoveredAtTurn",
             discovery.created_at AS "createdAt"
           FROM discovery_records AS discovery
           JOIN cells AS cell
             ON cell.campaign_id = discovery.campaign_id
            AND cell.id = discovery.cell_id
           JOIN countries AS discoverer
             ON discoverer.campaign_id = discovery.campaign_id
            AND discoverer.id = discovery.discovered_by_country_id
           WHERE discovery.campaign_id = $1
           ORDER BY discovery.discovered_at_turn DESC, discovery.id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             history.id, history.discovery_id AS "discoveryId",
             history.event_type AS "eventType",
             history.actor_country_id AS "actorCountryId",
             actor.name AS "actorCountryName",
             history.target_country_id AS "targetCountryId",
             target.name AS "targetCountryName",
             history.turn_number AS "turnNumber", history.payload,
             history.created_at AS "createdAt"
           FROM discovery_history AS history
           JOIN discovery_records AS discovery ON discovery.id = history.discovery_id
           JOIN countries AS actor ON actor.id = history.actor_country_id
           LEFT JOIN countries AS target ON target.id = history.target_country_id
           WHERE discovery.campaign_id = $1
           ORDER BY history.turn_number DESC, history.created_at DESC, history.id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             access.discovery_id AS "discoveryId", access.country_id AS "countryId",
             country.name AS "countryName", access.status,
             access.granted_at_turn AS "grantedAtTurn",
             access.granted_by_event_id AS "grantedByEventId",
             access.revoked_at_turn AS "revokedAtTurn",
             access.revoked_by_event_id AS "revokedByEventId",
             access.updated_at AS "updatedAt"
           FROM discovery_access AS access
           JOIN discovery_records AS discovery ON discovery.id = access.discovery_id
           JOIN countries AS country ON country.id = access.country_id
           WHERE discovery.campaign_id = $1
           ORDER BY access.discovery_id, access.country_id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT turn_number AS "turnNumber", report, created_at AS "createdAt"
           FROM economic_reports
           WHERE campaign_id = $1
           ORDER BY turn_number DESC`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT id, turn_number AS "turnNumber", report, created_at AS "createdAt"
           FROM battle_reports
           WHERE campaign_id = $1
           ORDER BY turn_number DESC, created_at DESC, id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             turn_number AS "turnNumber", version,
             state_schema_version AS "stateSchemaVersion",
             ruleset_version AS "rulesetVersion", created_at AS "createdAt"
           FROM world_snapshots
           WHERE campaign_id = $1
           ORDER BY turn_number DESC`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             turn_number AS "turnNumber", version,
             state_schema_version AS "stateSchemaVersion",
             ruleset_version AS "rulesetVersion", state,
             created_at AS "createdAt"
           FROM world_snapshots
           WHERE campaign_id = $1
           ORDER BY turn_number DESC
           LIMIT 1`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             id, job_key AS "jobKey", turn_number AS "turnNumber",
             snapshot_version AS "snapshotVersion", status, generation,
             worker_id AS "workerId", lease_until AS "leaseUntil",
             started_at AS "startedAt", completed_at AS "completedAt",
             retry_count AS "retryCount", created_at AS "createdAt"
           FROM turn_jobs
           WHERE campaign_id = $1
           ORDER BY turn_number DESC`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             turn_number AS "turnNumber", domain, draw_id AS "drawId",
             min_value::text AS "minValue", max_value::text AS "maxValue",
             value::text AS value, created_at AS "createdAt"
           FROM random_draws
           WHERE campaign_id = $1
           ORDER BY turn_number DESC, created_at DESC, domain, draw_id`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             turn_number AS "turnNumber", commitment, status,
             revealed_at AS "revealedAt", created_at AS "createdAt"
           FROM random_seeds
           WHERE campaign_id = $1
           ORDER BY turn_number DESC`,
          [campaignId],
        ),
        pool.query<Record<string, unknown>>(
          `SELECT
             audit.id, audit.action,
             audit.actor_user_id AS "actorUserId",
             actor.email AS "actorEmail",
             audit.turn_number AS "turnNumber",
             audit.details, audit.created_at AS "createdAt"
           FROM admin_audit_logs AS audit
           JOIN users AS actor ON actor.id = audit.actor_user_id
           WHERE audit.campaign_id = $1
           ORDER BY audit.created_at DESC, audit.id DESC
           LIMIT 100`,
          [campaignId],
        ),
      ]);

      return {
        campaign,
        members: members.rows,
        countries: countries.rows,
        socialSystems: socialSystems.rows,
        orders: orders.rows,
        events: events.rows,
        discoveries: discoveries.rows,
        discoveryHistory: discoveryHistory.rows,
        discoveryAccess: discoveryAccess.rows,
        economicReports: economicReports.rows,
        battleReports: battleReports.rows,
        snapshots: snapshots.rows,
        latestSnapshot: latestSnapshot.rows[0] ?? null,
        turnJobs: turnJobs.rows,
        randomDraws: randomDraws.rows,
        seedCommitments: seedCommitments.rows,
        auditLogs: auditLogs.rows,
      };
    },

    async forceCloseTurn(actorUserId, campaignId, expectedTurnNumber) {
      return closeOrders(pool, campaignId, {
        force: true,
        actorUserId,
        expectedTurnNumber,
      });
    },
  };
}
