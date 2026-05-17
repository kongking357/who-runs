export type RunnerLocation = {
  id?: string;
  user_id: string;
  team_id: string | null;
  username: string;
  latitude: number;
  longitude: number;
  distance_km: number;
  pace_sec_per_km: number;
  elapsed_sec: number;
  is_running: boolean;
  updated_at: string;
};

export type TrackPoint = { lat: number; lng: number; ts: number };
