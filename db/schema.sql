CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.trips (
 code text PRIMARY KEY,
 name text NOT NULL,
 days integer NOT NULL DEFAULT 3,
 author text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.points (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 trip_code text NOT NULL REFERENCES app.trips (code) ON DELETE CASCADE,
 title text NOT NULL,
 address text NOT NULL DEFAULT '',
 lat double precision NOT NULL,
 lng double precision NOT NULL,
 category text NOT NULL DEFAULT 'sight',
 day integer NOT NULL DEFAULT 0,
 note text NOT NULL DEFAULT '',
 cost text NOT NULL DEFAULT '',
 author text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX points_trip_day_idx ON app.points (trip_code, day);

CREATE TABLE app.comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 trip_code text NOT NULL REFERENCES app.trips (code) ON DELETE CASCADE,
 point_id uuid REFERENCES app.points (id) ON DELETE CASCADE,
 author text NOT NULL,
 text text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_trip_created_idx ON app.comments (trip_code, created_at);
