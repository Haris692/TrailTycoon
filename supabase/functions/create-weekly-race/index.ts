import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = 'https://yobmyrjccsxkuvafqiri.supabase.co'

const RACE_POOL = [
  { id: 'trail_15', name: 'Trail des Collines', loc: 'Chartreuse, France', dist: 15, elev: 600, diff: 'medium', lat: 45.35, lon: 5.85 },
  { id: 'trail_25', name: 'Trail du Vercors', loc: 'Vercors, France', dist: 25, elev: 1200, diff: 'medium', lat: 45.05, lon: 5.55 },
  { id: 'semi_trail', name: 'Semi-Marathon Trail', loc: 'Belledonne, France', dist: 21, elev: 900, diff: 'medium', lat: 45.25, lon: 5.95 },
  { id: 'marathon_trail', name: 'Marathon des Cimes', loc: 'Alpes, France', dist: 42, elev: 2500, diff: 'hard', lat: 45.92, lon: 6.87 },
  { id: 'trail_50', name: 'Ultra Trail 50K', loc: 'Mont-Blanc, France', dist: 50, elev: 3200, diff: 'hard', lat: 45.83, lon: 6.86 },
  { id: 'boston', name: 'Boston Marathon', loc: 'Boston, Massachusetts', dist: 42, elev: 150, diff: 'medium', lat: 42.36, lon: -71.06 },
  { id: 'pikes_peak', name: 'Pikes Peak Ascent', loc: 'Colorado Springs', dist: 21, elev: 2380, diff: 'hard', lat: 38.84, lon: -105.04 },
  { id: 'comrades', name: 'Comrades Marathon', loc: 'KwaZulu-Natal, South Africa', dist: 89, elev: 1700, diff: 'hard', lat: -29.60, lon: 30.38 },
  { id: 'kilimanjaro', name: 'Kilimanjaro Marathon', loc: 'Moshi, Tanzania', dist: 42, elev: 400, diff: 'medium', lat: -3.35, lon: 37.34 },
  { id: 'big_sur', name: 'Big Sur Marathon', loc: 'California Coast', dist: 42, elev: 600, diff: 'medium', lat: 36.27, lon: -121.81 },
]

function getNextSaturday18UTC(): string {
  const now = new Date()
  const day = now.getUTCDay()
  let daysUntilSat = (6 - day) % 7
  if (daysUntilSat === 0) daysUntilSat = 7
  const nextSat = new Date(now)
  nextSat.setUTCDate(nextSat.getUTCDate() + daysUntilSat)
  nextSat.setUTCHours(18, 0, 0, 0)
  return nextSat.toISOString()
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(SUPABASE_URL, serviceRoleKey)

    // Fetch last 4 races to avoid repeats
    const { data: recentRaces } = await supabase
      .from('lb_race_weeks')
      .select('race_id')
      .order('created_at', { ascending: false })
      .limit(4)

    const recentRaceIds = (recentRaces ?? []).map(r => r.race_id)
    const availableRaces = RACE_POOL.filter(r => !recentRaceIds.includes(r.id))
    const pool = availableRaces.length > 0 ? availableRaces : RACE_POOL
    const selectedRace = pool[Math.floor(Math.random() * pool.length)]

    const raceDate = getNextSaturday18UTC()

    // Insert using schema column names
    const { data: raceWeek, error: insertError } = await supabase
      .from('lb_race_weeks')
      .insert({
        race_id: selectedRace.id,
        race_name: selectedRace.name,
        race_loc: selectedRace.loc,
        race_dist: selectedRace.dist,
        race_elev: selectedRace.elev,
        race_diff: selectedRace.diff,
        race_lat: selectedRace.lat,
        race_lon: selectedRace.lon,
        race_date: raceDate,
        status: 'registration',
      })
      .select()
      .single()

    if (insertError) {
      return new Response(JSON.stringify({ error: 'Failed to create race week', details: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ success: true, race_week: raceWeek }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal server error', details: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
