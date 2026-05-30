import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://imloiwqyrlcodhlkrjrt.supabase.co',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImltbG9pd3F5cmxjb2RobGtyanJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMjIwOTcsImV4cCI6MjA5NDU5ODA5N30.jB9Hs5drFaRU47KE6lmEmGN5Z73sne5vi8HL1h3UvSs'
)

export type RunnerLocation = {
  id?: string
  user_id: string
  team_id: string | null
  latitude: number
  longitude: number
  display_name: string | null
  updated_at: string
}
