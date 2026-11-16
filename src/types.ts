export type IncomingMessage = {
  session_key: string;
  message_id: string;
  source_timestamp: number;
  chat_id: string;
  sender_id: string | null;
  received_at: string;
  raw_body: string;
  message_type: string;
};

export type ParsedChecklist = {
  machine: string;
  thickness: string;
  pressure: string;
  vacuum: string;
  notes: string;
};

export type ValidationError = {
  field: string;
  code:
    | 'INVALID_HEADER'
    | 'MALFORMED_LINE'
    | 'UNKNOWN_FIELD'
    | 'DUPLICATE_FIELD'
    | 'MISSING_FIELD'
    | 'EMPTY_FIELD'
    | 'INVALID_DECIMAL';
  message: string;
};

export type ParseResult =
  | { ok: true; value: ParsedChecklist }
  | { ok: false; errors: ValidationError[] };

export type JobData = { message: IncomingMessage; parsed: ParsedChecklist | null };

export type JobResult =
  | { status: 'accepted'; job_id: string }
  | { status: 'invalid'; errors: ValidationError[] };

export type DashboardRow = {
  message_id: string;
  timestamp: string;
  chat_id: string;
  sender_id: string | null;
  machine: string | null;
  thickness: number | null;
  pressure: number | null;
  vacuum: number | null;
  notes: string | null;
  status: 'received' | 'queued' | 'invalid' | 'accepted' | 'failed';
};
