-- ============================================================
-- Trail Tycoon — Competitive Leaderboard Schema
-- Supabase project: https://yobmyrjccsxkuvafqiri.supabase.co
-- ============================================================

-- ============================================================
-- 1. TABLES
-- ============================================================

-- Player profiles (one row per authenticated user)
CREATE TABLE lb_profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    username        TEXT UNIQUE NOT NULL,
    stats           JSONB DEFAULT '{"endurance":5,"speed":5,"technique":5,"mental":5}',
    energy          FLOAT DEFAULT 100,
    health          FLOAT DEFAULT 100,
    fatigue         FLOAT DEFAULT 0,
    trainings_today INT DEFAULT 0,
    last_training_date DATE,
    last_active_date   DATE DEFAULT CURRENT_DATE,
    is_injured      BOOLEAN DEFAULT FALSE,
    injury_name     TEXT,
    injury_ends_at  DATE,
    badges          JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Immutable training audit log
CREATE TABLE lb_training_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES lb_profiles (id) ON DELETE CASCADE,
    training_id     TEXT NOT NULL,
    stats_before    JSONB,
    stats_after     JSONB,
    energy_before   FLOAT,
    energy_after    FLOAT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- One race per week
CREATE TABLE lb_race_weeks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id         TEXT NOT NULL,
    race_name       TEXT NOT NULL,
    race_loc        TEXT NOT NULL,
    race_dist       FLOAT NOT NULL,
    race_elev       FLOAT NOT NULL,
    race_diff       TEXT NOT NULL,
    race_lat        FLOAT,
    race_lon        FLOAT,
    race_date       TIMESTAMPTZ NOT NULL,
    weather_code    INT,
    weather_desc    TEXT,
    weather_effect  INT DEFAULT 0,
    temperature     FLOAT,
    status          TEXT DEFAULT 'registration'
                        CHECK (status IN ('registration', 'racing', 'completed')),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Race registrations with stat snapshot
CREATE TABLE lb_race_registrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_week_id    UUID REFERENCES lb_race_weeks (id) ON DELETE CASCADE,
    user_id         UUID REFERENCES lb_profiles (id) ON DELETE CASCADE,
    stats_snapshot  JSONB NOT NULL,
    energy_snapshot FLOAT NOT NULL,
    health_snapshot FLOAT NOT NULL,
    fatigue_snapshot FLOAT NOT NULL,
    registered_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE (race_week_id, user_id)
);

-- Race results
CREATE TABLE lb_race_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    race_week_id    UUID REFERENCES lb_race_weeks (id) ON DELETE CASCADE,
    user_id         UUID REFERENCES lb_profiles (id) ON DELETE CASCADE,
    username        TEXT NOT NULL,
    position        INT,
    finish_time     FLOAT,
    dnf             BOOLEAN DEFAULT FALSE,
    points          INT DEFAULT 0,
    badge           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (race_week_id, user_id)
);

-- Global leaderboard
CREATE TABLE lb_global_leaderboard (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES lb_profiles (id) ON DELETE CASCADE UNIQUE,
    username        TEXT NOT NULL,
    total_points    INT DEFAULT 0,
    races_completed INT DEFAULT 0,
    races_won       INT DEFAULT 0,
    gold_medals     INT DEFAULT 0,
    silver_medals   INT DEFAULT 0,
    bronze_medals   INT DEFAULT 0,
    best_position   INT,
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX idx_lb_global_leaderboard_points
    ON lb_global_leaderboard (total_points DESC);

CREATE INDEX idx_lb_race_results_week_position
    ON lb_race_results (race_week_id, position);

CREATE INDEX idx_lb_training_log_user_created
    ON lb_training_log (user_id, created_at);

-- ============================================================
-- 3. ROW-LEVEL SECURITY
-- ============================================================

-- lb_profiles
ALTER TABLE lb_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lb_profiles: anyone can read"
    ON lb_profiles FOR SELECT
    USING (true);

CREATE POLICY "lb_profiles: service_role can insert"
    ON lb_profiles FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "lb_profiles: service_role can update"
    ON lb_profiles FOR UPDATE
    TO service_role
    USING (true)
    WITH CHECK (true);

-- lb_training_log
ALTER TABLE lb_training_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lb_training_log: read own rows"
    ON lb_training_log FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "lb_training_log: service_role can insert"
    ON lb_training_log FOR INSERT
    TO service_role
    WITH CHECK (true);

-- lb_race_weeks
ALTER TABLE lb_race_weeks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lb_race_weeks: anyone can read"
    ON lb_race_weeks FOR SELECT
    USING (true);

CREATE POLICY "lb_race_weeks: service_role can insert"
    ON lb_race_weeks FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "lb_race_weeks: service_role can update"
    ON lb_race_weeks FOR UPDATE
    TO service_role
    USING (true)
    WITH CHECK (true);

-- lb_race_registrations
ALTER TABLE lb_race_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lb_race_registrations: anyone can read"
    ON lb_race_registrations FOR SELECT
    USING (true);

CREATE POLICY "lb_race_registrations: insert own rows"
    ON lb_race_registrations FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- lb_race_results
ALTER TABLE lb_race_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lb_race_results: anyone can read"
    ON lb_race_results FOR SELECT
    USING (true);

CREATE POLICY "lb_race_results: service_role can insert"
    ON lb_race_results FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "lb_race_results: service_role can update"
    ON lb_race_results FOR UPDATE
    TO service_role
    USING (true)
    WITH CHECK (true);

-- lb_global_leaderboard
ALTER TABLE lb_global_leaderboard ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lb_global_leaderboard: anyone can read"
    ON lb_global_leaderboard FOR SELECT
    USING (true);

CREATE POLICY "lb_global_leaderboard: service_role can insert"
    ON lb_global_leaderboard FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "lb_global_leaderboard: service_role can update"
    ON lb_global_leaderboard FOR UPDATE
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================
-- 4. TRIGGER — Auto-create profile on signup
-- ============================================================

CREATE OR REPLACE FUNCTION handle_new_lb_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    _username TEXT;
BEGIN
    _username := NEW.raw_user_meta_data ->> 'username';

    INSERT INTO lb_profiles (id, username)
    VALUES (NEW.id, _username);

    INSERT INTO lb_global_leaderboard (user_id, username, total_points)
    VALUES (NEW.id, _username, 0);

    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_lb_user();

-- ============================================================
-- 5. CRON JOBS (pg_cron + pg_net)
-- ============================================================
-- Enable the extensions if not already enabled:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   CREATE EXTENSION IF NOT EXISTS pg_net;
--
-- Daily decay — runs every day at midnight UTC
-- Resets trainings_today, applies energy/fatigue recovery, checks injuries
SELECT cron.schedule(
    'daily-decay',
    '0 0 * * *',
    $$
    SELECT net.http_post(
        url   := 'https://yobmyrjccsxkuvafqiri.supabase.co/functions/v1/daily-decay',
        headers := '{"Authorization": "Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY"}'::JSONB,
        body  := '{}'::JSONB
    );
    $$
);

-- Create weekly race — runs every Monday at midnight UTC
-- Picks the next race and creates a new lb_race_weeks row
SELECT cron.schedule(
    'create-weekly-race',
    '0 0 * * 1',
    $$
    SELECT net.http_post(
        url   := 'https://yobmyrjccsxkuvafqiri.supabase.co/functions/v1/create-weekly-race',
        headers := '{"Authorization": "Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY"}'::JSONB,
        body  := '{}'::JSONB
    );
    $$
);

-- Simulate race — runs every Saturday at 18:00 UTC
-- Simulates the race for all registered participants and writes results
SELECT cron.schedule(
    'simulate-race',
    '0 18 * * 6',
    $$
    SELECT net.http_post(
        url   := 'https://yobmyrjccsxkuvafqiri.supabase.co/functions/v1/simulate-race',
        headers := '{"Authorization": "Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY"}'::JSONB,
        body  := '{}'::JSONB
    );
    $$
);
