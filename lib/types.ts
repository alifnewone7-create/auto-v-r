// Shared types mirroring the Neon schema. Keep these in sync with the SQL
// tables and with the Python agent's expectations.

// Lifecycle of a Telegram account inside the system:
//  new            -> just added, nothing done yet
//  purchased      -> bought via tg-lion, provision job queued (fully automatic)
//  provisioning   -> agent is running the full tg-lion flow (api + login + 2FA)
//  api_pending    -> create_app job queued, agent logging into my.telegram.org
//  api_code       -> agent needs the my.telegram.org login code from you
//  api_collected  -> api_id/api_hash captured and stored
//  login_pending  -> userbot login code requested (sent to the phone)
//  login_code     -> agent needs the Telegram login code from you
//  login_2fa      -> account has 2FA, agent needs the password
//  logged_in      -> session string stored, userbot ready
//  failed         -> something went wrong (see last_error)
export type AccountStatus =
  | "new"
  | "purchased"
  | "provisioning"
  | "api_pending"
  | "api_code"
  | "api_collected"
  | "login_pending"
  | "login_code"
  | "login_2fa"
  | "logged_in"
  | "failed"

export interface TelegramAccount {
  id: number
  label: string | null
  phone_number: string
  app_title: string
  short_name: string
  api_id: string | null
  api_hash: string | null
  session_string: string | null
  status: AccountStatus
  two_factor_required: boolean
  last_error: string | null
  // tg-lion provisioning metadata.
  source: "manual" | "tglion"
  country_code: string | null
  two_step_password: string | null
  // Live progress of the automatic tg-lion provisioning flow (buy -> api -> login).
  // provision_step is a human-readable status line; provision_code is the actual
  // Telegram login code the agent read from tg-lion. Both are null once done.
  provision_step: string | null
  provision_code: string | null
  created_at: string
  updated_at: string
}

export type JobType =
  | "provision_tglion" // full auto flow for a bought number: api + userbot login + 2FA
  | "create_app" // log into my.telegram.org, create app, return api_id/api_hash
  | "submit_mtproto_code" // pass the my.telegram.org login code to the agent
  | "send_login_code" // request a userbot login code (sent to the phone)
  | "submit_login_code" // pass the userbot login code (+ 2FA password) to the agent
  | "join_livestream" // join the live stream / video chat of a chat
  | "leave_livestream" // leave the live stream
  | "view_post" // view a channel post from every logged-in userbot
  | "detect_poll" // read the most recent poll in a channel and fill in vote_targets
  | "cast_vote" // make one userbot vote on a poll option
  | "retract_vote" // make one userbot remove its vote from a poll
  | "update_profile" // change an account's name / username / profile photo

export type JobStatus = "queued" | "processing" | "done" | "failed"

export interface Job {
  id: number
  type: JobType
  account_id: number | null
  payload: Record<string, any>
  status: JobStatus
  result: Record<string, any> | null
  error: string | null
  attempts: number
  claimed_at: string | null
  created_at: string
  updated_at: string
}

export type LivestreamStatus = "idle" | "joining" | "active" | "leaving" | "stopped" | "failed"

export interface LivestreamTarget {
  id: number
  chat_link: string
  title: string | null
  status: LivestreamStatus
  joined_count: number
  total_count: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface Agent {
  id: string
  hostname: string | null
  last_seen: string
  active_accounts: number
  note: string | null
}

export interface PollOption {
  index: number
  text: string
}

export type VoteTargetStatus = "detecting" | "ready" | "failed"
export type VoteCastStatus = "pending" | "voted" | "removing" | "failed"

export interface VoteTarget {
  id: number
  poll_link: string
  chat_id: number | null
  message_id: number | null
  poll_id: string | null
  question: string | null
  options: PollOption[]
  multiple_choice: boolean
  status: VoteTargetStatus
  last_error: string | null
  created_at: string
  updated_at: string
}

// Per-option aggregate of how our userbots have voted, returned by the API.
export interface VoteOptionTally {
  index: number
  text: string
  pending: number
  voted: number
  failed: number
  total: number // active casts (pending + voted) on this option
}

// A vote_targets row enriched with per-option tallies + availability counts.
export interface VoteTargetRow extends VoteTarget {
  tallies: VoteOptionTally[]
  used_accounts: number // accounts with an active cast on this poll
  available_accounts: number // logged-in userbots free to vote on this poll
}

export type ViewTargetStatus = "active" | "paused"

export interface ViewTarget {
  id: number
  channel_link: string
  chat_id: number | null
  title: string | null
  status: ViewTargetStatus
  last_seen_message_id: number
  posts_viewed: number
  views_sent: number
  last_post_at: string | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

// Pacing presets for auto-reactions. 'custom' uses custom_minutes as the exact
// window in which all userbots finish reacting.
export type ReactionMode = "slow" | "medium" | "fast" | "custom"
export type ReactionTargetStatus = "active" | "paused"

export interface ReactionTarget {
  id: number
  channel_link: string
  chat_id: number | null
  title: string | null
  emojis: string[]
  mode: ReactionMode
  custom_minutes: number
  status: ReactionTargetStatus
  last_seen_message_id: number
  posts_reacted: number
  reactions_sent: number
  last_post_at: string | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

// Lifecycle of a single profile edit request against one account.
//  pending -> queued, agent hasn't run it yet
//  done    -> profile changed successfully
//  failed  -> something went wrong (see last_error), e.g. username taken
export type ProfileUpdateStatus = "pending" | "done" | "failed"

export interface ProfileUpdate {
  id: number
  account_id: number
  first_name: string | null
  last_name: string | null
  username: string | null
  photo_asset_id: number | null
  status: ProfileUpdateStatus
  last_error: string | null
  created_at: string
  updated_at: string
}

// A telegram account row enriched with the latest profile-edit result, used by
// the bulk profile editor UI.
export interface ProfileAccountRow {
  id: number
  label: string | null
  phone_number: string
  status: AccountStatus
  profile_status: ProfileUpdateStatus | null
  profile_error: string | null
  profile_updated_at: string | null
}
