-- Friend requests: replaces instant friend adds with a request/accept flow.

CREATE TABLE IF NOT EXISTS public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> to_user_id)
);

-- At most one open request per ordered pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_unique_pending
  ON public.friend_requests(from_user_id, to_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_requests_incoming
  ON public.friend_requests(to_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_requests_outgoing
  ON public.friend_requests(from_user_id)
  WHERE status = 'pending';

ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see own friend requests" ON public.friend_requests;
CREATE POLICY "Users can see own friend requests"
  ON public.friend_requests FOR SELECT
  USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

DROP TRIGGER IF EXISTS friend_requests_updated_at ON public.friend_requests;
CREATE TRIGGER friend_requests_updated_at
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
