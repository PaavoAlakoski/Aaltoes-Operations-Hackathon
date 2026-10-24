// Generated from the live schema (Supabase `generate_typescript_types`, the same
// output as `supabase gen types typescript`). Do not edit by hand; regenerate
// after a migration.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      agent_suggestions: {
        Row: {
          cost_cents: number | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          error: string | null
          executed_at: string | null
          group_id: string | null
          id: string
          incident_id: string
          model: string | null
          payload: Json
          rationale: string
          reasoning_trace: Json
          status: Database["public"]["Enums"]["suggestion_status"]
          step: number
          suggestion_type: string
          title: string | null
          updated_at: string
        }
        Insert: {
          cost_cents?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          error?: string | null
          executed_at?: string | null
          group_id?: string | null
          id?: string
          incident_id: string
          model?: string | null
          payload?: Json
          rationale: string
          reasoning_trace?: Json
          status?: Database["public"]["Enums"]["suggestion_status"]
          step?: number
          suggestion_type: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          cost_cents?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          error?: string | null
          executed_at?: string | null
          group_id?: string | null
          id?: string
          incident_id?: string
          model?: string | null
          payload?: Json
          rationale?: string
          reasoning_trace?: Json
          status?: Database["public"]["Enums"]["suggestion_status"]
          step?: number
          suggestion_type?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_suggestions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_suggestions_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
        ]
      }
      assignments: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          shift_end: string
          shift_start: string
          status: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          shift_end: string
          shift_start: string
          status?: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          shift_end?: string
          shift_start?: string
          status?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          created_at: string
          details: Json
          id: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          created_at?: string
          details?: Json
          id?: never
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          created_at?: string
          details?: Json
          id?: never
        }
        Relationships: []
      }
      autonomy: {
        Row: {
          action_kind: string
          level: string
          locked: boolean
          updated_at: string
        }
        Insert: {
          action_kind: string
          level: string
          locked?: boolean
          updated_at?: string
        }
        Update: {
          action_kind?: string
          level?: string
          locked?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      corridors: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          path: Json
          updated_at: string
        }
        Insert: {
          color: string
          created_at?: string
          id: string
          name: string
          path?: Json
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          path?: Json
          updated_at?: string
        }
        Relationships: []
      }
      decisions: {
        Row: {
          action: string
          decided_at: string
          decided_by: string
          effects: Json
          id: string
          note: string | null
          order_id: string
          target_id: string
          target_type: string
          undone_at: string | null
        }
        Insert: {
          action: string
          decided_at?: string
          decided_by: string
          effects?: Json
          id?: string
          note?: string | null
          order_id: string
          target_id: string
          target_type: string
          undone_at?: string | null
        }
        Update: {
          action?: string
          decided_at?: string
          decided_by?: string
          effects?: Json
          id?: string
          note?: string | null
          order_id?: string
          target_id?: string
          target_type?: string
          undone_at?: string | null
        }
        Relationships: []
      }
      driver_chat_messages: {
        Row: {
          body: string
          created_at: string
          driver_id: string
          id: string
          incident_id: string | null
          role: string
          vehicle_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          driver_id: string
          id?: string
          incident_id?: string | null
          role: string
          vehicle_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          driver_id?: string
          id?: string
          incident_id?: string | null
          role?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_chat_messages_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_chat_messages_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_chat_messages_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_stays: {
        Row: {
          address: string
          created_at: string
          driver_id: string
          id: string
          lat: number | null
          lng: number | null
          name: string
          nights: number
          place_id: string
          suggestion_id: string | null
        }
        Insert: {
          address?: string
          created_at?: string
          driver_id: string
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          nights?: number
          place_id: string
          suggestion_id?: string | null
        }
        Update: {
          address?: string
          created_at?: string
          driver_id?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          nights?: number
          place_id?: string
          suggestion_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_stays_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_trips: {
        Row: {
          created_at: string
          delay_minutes: number
          driver_id: string
          from_name: string
          id: string
          mode: string
          scheduled_arrival: string
          service: string
          simulated: boolean
          status: string
          to_lat: number
          to_lng: number
          to_name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          delay_minutes?: number
          driver_id: string
          from_name: string
          id?: string
          mode?: string
          scheduled_arrival: string
          service: string
          simulated?: boolean
          status?: string
          to_lat: number
          to_lng: number
          to_name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          delay_minutes?: number
          driver_id?: string
          from_name?: string
          id?: string
          mode?: string
          scheduled_arrival?: string
          service?: string
          simulated?: boolean
          status?: string
          to_lat?: number
          to_lng?: number
          to_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ferry_bookings: {
        Row: {
          created_at: string
          departure_id: string
          id: string
          status: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          departure_id: string
          id?: string
          status?: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          departure_id?: string
          id?: string
          status?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ferry_bookings_departure_id_fkey"
            columns: ["departure_id"]
            isOneToOne: false
            referencedRelation: "ferry_departures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ferry_bookings_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: true
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      ferry_departures: {
        Row: {
          check_in_closes_at: string
          created_at: string
          departs_at: string
          from_port: string
          id: string
          operator: string
          rebooking_fee_cents: number
          to_port: string
          vehicle_slots_left: number
        }
        Insert: {
          check_in_closes_at: string
          created_at?: string
          departs_at: string
          from_port: string
          id?: string
          operator: string
          rebooking_fee_cents: number
          to_port: string
          vehicle_slots_left: number
        }
        Update: {
          check_in_closes_at?: string
          created_at?: string
          departs_at?: string
          from_port?: string
          id?: string
          operator?: string
          rebooking_fee_cents?: number
          to_port?: string
          vehicle_slots_left?: number
        }
        Relationships: [
          {
            foreignKeyName: "ferry_departures_from_port_fkey"
            columns: ["from_port"]
            isOneToOne: false
            referencedRelation: "ports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ferry_departures_to_port_fkey"
            columns: ["to_port"]
            isOneToOne: false
            referencedRelation: "ports"
            referencedColumns: ["id"]
          },
        ]
      }
      hotel_bookings: {
        Row: {
          cost_cents: number
          created_at: string
          driver_id: string
          hotel_id: string
          id: string
          nights: number
          suggestion_id: string | null
        }
        Insert: {
          cost_cents: number
          created_at?: string
          driver_id: string
          hotel_id: string
          id?: string
          nights: number
          suggestion_id?: string | null
        }
        Update: {
          cost_cents?: number
          created_at?: string
          driver_id?: string
          hotel_id?: string
          id?: string
          nights?: number
          suggestion_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hotel_bookings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hotel_bookings_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
        ]
      }
      hotels: {
        Row: {
          distance_km: number
          id: string
          name: string
          nightly_rate_cents: number
          port_id: string
          rooms_left: number
        }
        Insert: {
          distance_km: number
          id: string
          name: string
          nightly_rate_cents: number
          port_id: string
          rooms_left: number
        }
        Update: {
          distance_km?: number
          id?: string
          name?: string
          nightly_rate_cents?: number
          port_id?: string
          rooms_left?: number
        }
        Relationships: [
          {
            foreignKeyName: "hotels_port_id_fkey"
            columns: ["port_id"]
            isOneToOne: false
            referencedRelation: "ports"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          assigned_to: string | null
          created_at: string
          description: string
          id: string
          kind: string
          reported_by: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: Database["public"]["Enums"]["incident_severity"]
          source: Database["public"]["Enums"]["incident_source"]
          status: Database["public"]["Enums"]["incident_status"]
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          assigned_to?: string | null
          created_at?: string
          description?: string
          id?: string
          kind: string
          reported_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: Database["public"]["Enums"]["incident_severity"]
          source?: Database["public"]["Enums"]["incident_source"]
          status?: Database["public"]["Enums"]["incident_status"]
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          assigned_to?: string | null
          created_at?: string
          description?: string
          id?: string
          kind?: string
          reported_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: Database["public"]["Enums"]["incident_severity"]
          source?: Database["public"]["Enums"]["incident_source"]
          status?: Database["public"]["Enums"]["incident_status"]
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      market_jobs: {
        Row: {
          delivery_city: string
          fee_cents: number
          id: string
          label: string
          offer_suggestion_id: string | null
          offered_to: string | null
          order_ref: string
          pickup_city: string
          pickup_lat: number
          pickup_lng: number
          pickup_name: string
          status: string
          timezone: string
          updated_at: string
          window_end: string
          window_start: string
        }
        Insert: {
          delivery_city: string
          fee_cents: number
          id: string
          label: string
          offer_suggestion_id?: string | null
          offered_to?: string | null
          order_ref: string
          pickup_city: string
          pickup_lat: number
          pickup_lng: number
          pickup_name: string
          status?: string
          timezone: string
          updated_at?: string
          window_end: string
          window_start: string
        }
        Update: {
          delivery_city?: string
          fee_cents?: number
          id?: string
          label?: string
          offer_suggestion_id?: string | null
          offered_to?: string | null
          order_ref?: string
          pickup_city?: string
          pickup_lat?: number
          pickup_lng?: number
          pickup_name?: string
          status?: string
          timezone?: string
          updated_at?: string
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_jobs_offered_to_fkey"
            columns: ["offered_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          created_at: string
          from_user: string | null
          id: string
          incident_id: string | null
          read_at: string | null
          to_corridor: string | null
          to_user: string | null
          to_vehicle: string | null
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          from_user?: string | null
          id?: string
          incident_id?: string | null
          read_at?: string | null
          to_corridor?: string | null
          to_user?: string | null
          to_vehicle?: string | null
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          from_user?: string | null
          id?: string
          incident_id?: string | null
          read_at?: string | null
          to_corridor?: string | null
          to_user?: string | null
          to_vehicle?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_from_user_fkey"
            columns: ["from_user"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_to_corridor_fkey"
            columns: ["to_corridor"]
            isOneToOne: false
            referencedRelation: "corridors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_to_user_fkey"
            columns: ["to_user"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_to_vehicle_fkey"
            columns: ["to_vehicle"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      pickup_sites: {
        Row: {
          access_note: string
          city: string
          closes_at: string | null
          id: string
          key_handover: string
          lat: number
          lng: number
          name: string
          opening_hours: Json
          timezone: string
        }
        Insert: {
          access_note?: string
          city: string
          closes_at?: string | null
          id: string
          key_handover?: string
          lat: number
          lng: number
          name: string
          opening_hours?: Json
          timezone: string
        }
        Update: {
          access_note?: string
          city?: string
          closes_at?: string | null
          id?: string
          key_handover?: string
          lat?: number
          lng?: number
          name?: string
          opening_hours?: Json
          timezone?: string
        }
        Relationships: []
      }
      ports: {
        Row: {
          id: string
          lat: number
          lng: number
          name: string
          timezone: string
        }
        Insert: {
          id: string
          lat: number
          lng: number
          name: string
          timezone: string
        }
        Update: {
          id?: string
          lat?: number
          lng?: number
          name?: string
          timezone?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          availability: string
          created_at: string
          driver_ref: string | null
          full_name: string
          id: string
          lat: number | null
          lng: number | null
          position_at: string | null
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          availability?: string
          created_at?: string
          driver_ref?: string | null
          full_name?: string
          id: string
          lat?: number | null
          lng?: number | null
          position_at?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          availability?: string
          created_at?: string
          driver_ref?: string | null
          full_name?: string
          id?: string
          lat?: number | null
          lng?: number | null
          position_at?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      records: {
        Row: {
          collection: string
          data: Json
          id: string
          order_id: string | null
        }
        Insert: {
          collection: string
          data: Json
          id: string
          order_id?: string | null
        }
        Update: {
          collection?: string
          data?: Json
          id?: string
          order_id?: string | null
        }
        Relationships: []
      }
      vehicles: {
        Row: {
          corridor_id: string
          created_at: string
          delay_seconds: number
          eta: string | null
          id: string
          label: string
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          order_id: string | null
          order_ref: string | null
          pickup_checked_at: string | null
          pickup_eta: string | null
          pickup_eta_basis: string | null
          pickup_in_time: boolean | null
          pickup_site_id: string | null
          registration: string | null
          status: Database["public"]["Enums"]["vehicle_status"]
          updated_at: string
        }
        Insert: {
          corridor_id: string
          created_at?: string
          delay_seconds?: number
          eta?: string | null
          id: string
          label: string
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          order_id?: string | null
          order_ref?: string | null
          pickup_checked_at?: string | null
          pickup_eta?: string | null
          pickup_eta_basis?: string | null
          pickup_in_time?: boolean | null
          pickup_site_id?: string | null
          registration?: string | null
          status?: Database["public"]["Enums"]["vehicle_status"]
          updated_at?: string
        }
        Update: {
          corridor_id?: string
          created_at?: string
          delay_seconds?: number
          eta?: string | null
          id?: string
          label?: string
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          order_id?: string | null
          order_ref?: string | null
          pickup_checked_at?: string | null
          pickup_eta?: string | null
          pickup_eta_basis?: string | null
          pickup_in_time?: boolean | null
          pickup_site_id?: string | null
          registration?: string | null
          status?: Database["public"]["Enums"]["vehicle_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_corridor_id_fkey"
            columns: ["corridor_id"]
            isOneToOne: false
            referencedRelation: "corridors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_pickup_site_id_fkey"
            columns: ["pickup_site_id"]
            isOneToOne: false
            referencedRelation: "pickup_sites"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ops_kpis: {
        Row: {
          avg_ack_seconds: number | null
          on_time_pct: number | null
          open_incidents: number | null
          pending_suggestions: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      _allowed_actions: {
        Args: { p_status: string; p_target_type: string }
        Returns: string[]
      }
      acknowledge_incident: {
        Args: { p_incident_id: string }
        Returns: Database["public"]["Tables"]["incidents"]["Row"]
      }
      agent_available_drivers: { Args: { p_vehicle_id: string }; Returns: Json }
      agent_check_pickup_feasibility: {
        Args: { p_vehicle_id: string }
        Returns: Json
      }
      agent_find_hotel_near_port: { Args: { p_port_id: string }; Returns: Json }
      agent_find_market_jobs: {
        Args: { p_after: string; p_lat: number; p_lng: number }
        Returns: Json
      }
      agent_find_next_ferry: {
        Args: { p_from_port: string; p_not_before: string }
        Returns: Json
      }
      agent_incident_context: { Args: { p_incident_id: string }; Returns: Json }
      agent_pickup_context: { Args: { p_vehicle_id: string }; Returns: Json }
      agent_pickups_to_watch: { Args: never; Returns: string[] }
      answer_market_job: {
        Args: { p_accept: boolean; p_job_id: string }
        Returns: Database["public"]["Tables"]["market_jobs"]["Row"]
      }
      apply_suggestion: {
        Args: { p_suggestion_id: string }
        Returns: Database["public"]["Tables"]["agent_suggestions"]["Row"]
      }
      assign_incident: {
        Args: { p_assignee: string; p_incident_id: string }
        Returns: Database["public"]["Tables"]["incidents"]["Row"]
      }
      clear_live_activity: { Args: never; Returns: Json }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      decide: {
        Args: {
          p_action: string
          p_effects?: Json
          p_note?: string
          p_order_id: string
          p_target_id: string
        }
        Returns: Database["public"]["Tables"]["decisions"]["Row"]
      }
      decide_suggestion: {
        Args: { p_decision: string; p_note?: string; p_suggestion_id: string }
        Returns: Database["public"]["Tables"]["agent_suggestions"]["Row"]
      }
      mark_message_read: { Args: { p_message_id: string }; Returns: undefined }
      report_position: {
        Args: {
          p_delay_seconds?: number
          p_eta?: string
          p_lat: number
          p_lng: number
        }
        Returns: Json
      }
      resolve_incident: {
        Args: { p_incident_id: string; p_note?: string }
        Returns: Database["public"]["Tables"]["incidents"]["Row"]
      }
      set_autonomy: {
        Args: { p_kind: string; p_level: string }
        Returns: Database["public"]["Tables"]["autonomy"]["Row"]
      }
      set_user_role: {
        Args: {
          p_role: Database["public"]["Enums"]["app_role"]
          p_user_id: string
          p_vehicle_id?: string
        }
        Returns: Database["public"]["Tables"]["profiles"]["Row"]
      }
      set_vehicle_status: {
        Args: {
          p_reason?: string
          p_status: Database["public"]["Enums"]["vehicle_status"]
          p_vehicle_id: string
        }
        Returns: Database["public"]["Tables"]["vehicles"]["Row"]
      }
      simulate_ferry_jam: {
        Args: never
        Returns: Database["public"]["Tables"]["incidents"]["Row"]
      }
      simulate_train_delay: { Args: never; Returns: Json }
      undo_decision: {
        Args: { p_id: string }
        Returns: Database["public"]["Tables"]["decisions"]["Row"]
      }
      verify_agent_secret: { Args: { p_secret: string }; Returns: boolean }
    }
    Enums: {
      actor_type: "user" | "agent" | "system"
      app_role: "driver" | "dispatcher" | "supervisor"
      incident_severity: "low" | "medium" | "high" | "critical"
      incident_source: "driver" | "control" | "agent" | "system"
      incident_status: "open" | "acknowledged" | "resolved"
      suggestion_status: "pending" | "approved" | "rejected" | "executed" | "failed"
      vehicle_status:
        | "waiting_pickup"
        | "moving"
        | "stopped"
        | "on_ferry"
        | "needs_check"
        | "delivered"
        | "offline"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database["public"]

export type Tables<T extends keyof (PublicSchema["Tables"] & PublicSchema["Views"])> =
  (PublicSchema["Tables"] & PublicSchema["Views"])[T] extends { Row: infer R } ? R : never
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]

export const Constants = {
  public: {
    Enums: {
      actor_type: ["user", "agent", "system"],
      app_role: ["driver", "dispatcher", "supervisor"],
      incident_severity: ["low", "medium", "high", "critical"],
      incident_source: ["driver", "control", "agent", "system"],
      incident_status: ["open", "acknowledged", "resolved"],
      suggestion_status: ["pending", "approved", "rejected", "executed", "failed"],
      vehicle_status: ["waiting_pickup", "moving", "stopped", "on_ferry", "needs_check", "delivered", "offline"],
    },
  },
} as const
