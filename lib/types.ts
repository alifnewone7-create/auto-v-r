// Shared types mirroring the Neon schema. Keep these in sync with the SQL
// tables and with the Python agent's expectations.

// Lifecycle of a Telegram account inside the system:
//  new            -> just added, nothing done yet
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
  created_at: string
  updated_at: string
}

export type JobType =
  | "create_app" // log into my.telegram.org, create app, return api_id/api_hash
  | "submit_mtproto_code" // pass the my.telegram.org login code to the agent
  | "send_login_code" // request a userbot login code (sent to the phone)
  | "submit_login_code" // pass the userbot login code (+ 2FA password) to the agent
  | "join_livestream" // join the live stream / video chat of a chat
  | "leave_livestream" // leave the live stream
  | "view_post" // view a channel post from every logged-in userbot

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
