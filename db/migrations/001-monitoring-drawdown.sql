CREATE TABLE public.monitoring_drawdown (
  job_id text PRIMARY KEY,
  session_key text NOT NULL,
  message_id text NOT NULL,
  source_timestamp bigint NOT NULL,
  chat_id text NOT NULL,
  sender_id text,
  received_at timestamptz NOT NULL,
  raw_body text NOT NULL,
  message_type text NOT NULL,
  machine text NOT NULL,
  thickness numeric NOT NULL,
  pressure numeric NOT NULL,
  vacuum numeric NOT NULL,
  notes text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_key, message_id)
);

CREATE INDEX monitoring_drawdown_received_at_job_id_idx
  ON public.monitoring_drawdown (received_at DESC, job_id DESC);

CREATE INDEX monitoring_drawdown_machine_received_at_job_id_idx
  ON public.monitoring_drawdown (machine, received_at DESC, job_id DESC);

REVOKE ALL ON public.monitoring_drawdown FROM PUBLIC, monitor_worker, monitor_reader;
GRANT SELECT, INSERT ON public.monitoring_drawdown TO monitor_worker;
GRANT SELECT ON public.monitoring_drawdown TO monitor_reader;
