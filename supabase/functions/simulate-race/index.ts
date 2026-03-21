import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = 'https://yobmyrjccsxkuvafqiri.supabase.co'

const POINTS_TABLE: Record<number, number> = {
  1: 100, 2: 80, 3: 60, 4: 50, 5: 45,
  6: 40, 7: 35, 8: 30, 9: 25, 10: 20,
}
const DEFAULT_POINTS = 10
const DNF_POINTS = 5

// Map WMO weather codes to game effects
function mapWeatherCode(code: number): { effect: number; desc: string } {
  if (code <= 3) return { effect: 0, desc: 'Clear skies' }
  if (code <= 48) return { effect: -5, desc: 'Fog' }
  if (code <= 57) return { effect: -5, desc: 'Drizzle' }
  if (code <= 67) return { effect: -5, desc: 'Rain' }
  if (code <= 77) return { effect: -10, desc: 'Snow' }
  if (code <= 82) return { effect: -5, desc: 'Rain showers' }
  if (code <= 86) return { effect: -10, desc: 'Snow showers' }
  return { effect: -10, desc: 'Thunderstorm' }
}

function getDrainRate(diff: string): number {
  switch (diff) {
    case 'easy': return 2
    case 'medium': return 3.5
    case 'hard': return 5
    case 'extreme': return 7
    default: return 10
  }
}

function getBasePaceBase(diff: string): number {
  switch (diff) {
    case 'easy': return 360
    case 'medium': return 420
    case 'hard': return 480
    case 'extreme': return 540
    default: return 600
  }
}

interface Stats {
  endurance: number
  speed: number
  technique: number
  mental: number
}

function simulateRace(
  stats: Stats,
  energy: number,
  _health: number,
  _fatigue: number,
  dist: number,
  elev: number,
  diff: string,
  weatherEffect: number,
): { finishTime: number; isDnf: boolean } {
  const base = getBasePaceBase(diff)
  const basePace = Math.max(240, base - stats.speed * 0.8 - stats.technique * 0.5 * (elev / dist / 50))
  const kmPerStep = Math.max(1, Math.round(dist / 20))
  const drainRate = getDrainRate(diff)

  let energyLeft = energy
  let elapsed = 0

  for (let km = 0; km < dist; km += kmPerStep) {
    energyLeft -= drainRate * (1 - stats.endurance / 200)
    if (weatherEffect < 0) energyLeft += weatherEffect * 0.1

    let fatigueMult = 1
    if (energyLeft > 60) fatigueMult = 1
    else if (energyLeft > 30) fatigueMult = 1.1
    else if (energyLeft > 10) fatigueMult = 1.3
    else fatigueMult = 1.6

    // Add randomness per step
    const randomFactor = 0.95 + Math.random() * 0.1
    const currentPace = basePace * fatigueMult * randomFactor
    elapsed += currentPace * kmPerStep

    // DNF check
    if (energyLeft <= 0 && stats.mental < 40) {
      return { finishTime: -1, isDnf: true }
    }
  }

  return { finishTime: Math.round(elapsed), isDnf: false }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(SUPABASE_URL, serviceRoleKey)

    const now = new Date()

    // Find race with status 'registration' and race_date <= now
    const { data: raceWeek, error: raceError } = await supabase
      .from('lb_race_weeks')
      .select('*')
      .eq('status', 'registration')
      .lte('race_date', now.toISOString())
      .order('race_date', { ascending: false })
      .limit(1)
      .single()

    if (raceError || !raceWeek) {
      return new Response(JSON.stringify({ error: 'No race ready to simulate', details: raceError?.message }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch weather from Open-Meteo (free, no API key)
    let weatherEffect = 0
    let weatherCode: number | null = null
    let weatherDesc = 'Unknown'
    let temperature: number | null = null

    if (raceWeek.race_lat && raceWeek.race_lon) {
      try {
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${raceWeek.race_lat}&longitude=${raceWeek.race_lon}&current_weather=true`
        const weatherRes = await fetch(weatherUrl)
        if (weatherRes.ok) {
          const weatherJson = await weatherRes.json()
          const cw = weatherJson.current_weather
          if (cw) {
            weatherCode = cw.weathercode
            temperature = cw.temperature
            const mapped = mapWeatherCode(cw.weathercode)
            weatherEffect = mapped.effect
            weatherDesc = mapped.desc
          }
        }
      } catch (_e) {
        // Weather fetch failed, use defaults
      }
    }

    // Update race_weeks with weather data
    await supabase
      .from('lb_race_weeks')
      .update({
        weather_code: weatherCode,
        weather_desc: weatherDesc,
        weather_effect: weatherEffect,
        temperature,
        status: 'racing',
      })
      .eq('id', raceWeek.id)

    // Fetch all registered participants
    const { data: registrations, error: partError } = await supabase
      .from('lb_race_registrations')
      .select('*, lb_profiles(username)')
      .eq('race_week_id', raceWeek.id)

    if (partError) {
      return new Response(JSON.stringify({ error: 'Failed to fetch participants', details: partError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!registrations || registrations.length === 0) {
      await supabase.from('lb_race_weeks').update({ status: 'completed' }).eq('id', raceWeek.id)
      return new Response(JSON.stringify({ success: true, message: 'No participants', results: [] }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Simulate race for each participant
    interface SimResult {
      userId: string
      username: string
      finishTime: number
      isDnf: boolean
    }
    const simResults: SimResult[] = []

    for (const reg of registrations) {
      const stats: Stats = {
        endurance: reg.stats_snapshot?.endurance ?? 10,
        speed: reg.stats_snapshot?.speed ?? 10,
        technique: reg.stats_snapshot?.technique ?? 10,
        mental: reg.stats_snapshot?.mental ?? 10,
      }

      const { finishTime, isDnf } = simulateRace(
        stats,
        reg.energy_snapshot ?? 50,
        reg.health_snapshot ?? 50,
        reg.fatigue_snapshot ?? 0,
        raceWeek.race_dist,
        raceWeek.race_elev,
        raceWeek.race_diff,
        weatherEffect,
      )

      simResults.push({
        userId: reg.user_id,
        username: reg.lb_profiles?.username ?? 'Unknown',
        finishTime,
        isDnf,
      })
    }

    // Sort: finishers by time, DNFs last
    simResults.sort((a, b) => {
      if (a.isDnf && b.isDnf) return 0
      if (a.isDnf) return 1
      if (b.isDnf) return -1
      return a.finishTime - b.finishTime
    })

    // Assign positions, points, badges
    const raceResults = simResults.map((r, i) => {
      const position = i + 1
      let points: number
      let badge: string | null = null

      if (r.isDnf) {
        points = DNF_POINTS
      } else {
        points = POINTS_TABLE[position] ?? DEFAULT_POINTS
        if (position === 1) badge = 'gold'
        else if (position === 2) badge = 'silver'
        else if (position === 3) badge = 'bronze'
      }

      return {
        race_week_id: raceWeek.id,
        user_id: r.userId,
        username: r.username,
        position,
        finish_time: r.isDnf ? null : r.finishTime,
        dnf: r.isDnf,
        points,
        badge,
      }
    })

    // Insert race results
    const { error: resultsError } = await supabase.from('lb_race_results').insert(raceResults)
    if (resultsError) {
      return new Response(JSON.stringify({ error: 'Failed to insert results', details: resultsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Update global leaderboard + profiles badges
    for (const result of raceResults) {
      const { data: existing } = await supabase
        .from('lb_global_leaderboard')
        .select('*')
        .eq('user_id', result.user_id)
        .single()

      if (existing) {
        const lbUpdates: Record<string, unknown> = {
          total_points: (existing.total_points ?? 0) + result.points,
          races_completed: (existing.races_completed ?? 0) + 1,
          updated_at: now.toISOString(),
        }

        if (result.position === 1) lbUpdates.races_won = (existing.races_won ?? 0) + 1
        if (!result.dnf && (!existing.best_position || result.position < existing.best_position)) {
          lbUpdates.best_position = result.position
        }
        if (result.badge === 'gold') lbUpdates.gold_medals = (existing.gold_medals ?? 0) + 1
        if (result.badge === 'silver') lbUpdates.silver_medals = (existing.silver_medals ?? 0) + 1
        if (result.badge === 'bronze') lbUpdates.bronze_medals = (existing.bronze_medals ?? 0) + 1

        await supabase.from('lb_global_leaderboard').update(lbUpdates).eq('user_id', result.user_id)
      }

      // Add badge to profile
      if (result.badge) {
        const { data: profile } = await supabase
          .from('lb_profiles')
          .select('badges')
          .eq('id', result.user_id)
          .single()

        if (profile) {
          const badges = profile.badges ?? []
          badges.push({
            type: result.badge,
            race: raceWeek.race_name,
            position: result.position,
            date: now.toISOString().slice(0, 10),
          })
          await supabase.from('lb_profiles').update({ badges }).eq('id', result.user_id)
        }
      }
    }

    // Mark race as completed
    await supabase.from('lb_race_weeks').update({ status: 'completed' }).eq('id', raceWeek.id)

    return new Response(JSON.stringify({
      success: true,
      race: raceWeek.race_name,
      weather: { code: weatherCode, desc: weatherDesc, effect: weatherEffect, temperature },
      participants: simResults.length,
      results: raceResults,
    }), {
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
