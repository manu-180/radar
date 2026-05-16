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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      keywords: {
        Row: {
          created_at: string
          enabled: boolean
          id: number
          kind: string
          lang: string
          term: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: never
          kind: string
          lang?: string
          term: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: never
          kind?: string
          lang?: string
          term?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          author: string | null
          body: string | null
          category: string | null
          content_hash: string
          external_id: string | null
          feedback: string | null
          feedback_at: string | null
          first_seen_at: string
          id: number
          input_tokens: number | null
          lang: string | null
          last_seen_at: string
          llm_attempts: number
          llm_cost_usd: number | null
          llm_error: string | null
          llm_model: string | null
          llm_status: string
          notified_at: string | null
          notify_status: string
          output_tokens: number | null
          posted_at: string | null
          prefilter_matched: string[] | null
          raw: Json | null
          reason: string | null
          score: number | null
          source: string
          suggested_reply: string | null
          title: string | null
          url: string | null
        }
        Insert: {
          author?: string | null
          body?: string | null
          category?: string | null
          content_hash: string
          external_id?: string | null
          feedback?: string | null
          feedback_at?: string | null
          first_seen_at?: string
          id?: never
          input_tokens?: number | null
          lang?: string | null
          last_seen_at?: string
          llm_attempts?: number
          llm_cost_usd?: number | null
          llm_error?: string | null
          llm_model?: string | null
          llm_status?: string
          notified_at?: string | null
          notify_status?: string
          output_tokens?: number | null
          posted_at?: string | null
          prefilter_matched?: string[] | null
          raw?: Json | null
          reason?: string | null
          score?: number | null
          source: string
          suggested_reply?: string | null
          title?: string | null
          url?: string | null
        }
        Update: {
          author?: string | null
          body?: string | null
          category?: string | null
          content_hash?: string
          external_id?: string | null
          feedback?: string | null
          feedback_at?: string | null
          first_seen_at?: string
          id?: never
          input_tokens?: number | null
          lang?: string | null
          last_seen_at?: string
          llm_attempts?: number
          llm_cost_usd?: number | null
          llm_error?: string | null
          llm_model?: string | null
          llm_status?: string
          notified_at?: string | null
          notify_status?: string
          output_tokens?: number | null
          posted_at?: string | null
          prefilter_matched?: string[] | null
          raw?: Json | null
          reason?: string | null
          score?: number | null
          source?: string
          suggested_reply?: string | null
          title?: string | null
          url?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          channel: string
          created_at: string
          error: string | null
          id: number
          lead_id: number | null
          status: string
          updated_at: string
          wassenger_id: string | null
        }
        Insert: {
          channel?: string
          created_at?: string
          error?: string | null
          id?: never
          lead_id?: number | null
          status?: string
          updated_at?: string
          wassenger_id?: string | null
        }
        Update: {
          channel?: string
          created_at?: string
          error?: string | null
          id?: never
          lead_id?: number | null
          status?: string
          updated_at?: string
          wassenger_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: number
          items_found: number
          items_new: number
          items_processed: number
          kind: string
          source: string | null
          started_at: string
          status: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: never
          items_found?: number
          items_new?: number
          items_processed?: number
          kind: string
          source?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: never
          items_found?: number
          items_new?: number
          items_processed?: number
          kind?: string
          source?: string | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      sources: {
        Row: {
          config: Json
          created_at: string
          cursor: Json
          enabled: boolean
          id: number
          last_polled_at: string | null
          name: string
          poll_interval_minutes: number
          slug: string
        }
        Insert: {
          config?: Json
          created_at?: string
          cursor?: Json
          enabled?: boolean
          id?: never
          last_polled_at?: string | null
          name: string
          poll_interval_minutes?: number
          slug: string
        }
        Update: {
          config?: Json
          created_at?: string
          cursor?: Json
          enabled?: boolean
          id?: never
          last_polled_at?: string | null
          name?: string
          poll_interval_minutes?: number
          slug?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_leads_to_notify: {
        Args: { batch_size: number; cats: string[]; min_score: number }
        Returns: {
          author: string | null
          body: string | null
          category: string | null
          content_hash: string
          external_id: string | null
          feedback: string | null
          feedback_at: string | null
          first_seen_at: string
          id: number
          input_tokens: number | null
          lang: string | null
          last_seen_at: string
          llm_attempts: number
          llm_cost_usd: number | null
          llm_error: string | null
          llm_model: string | null
          llm_status: string
          notified_at: string | null
          notify_status: string
          output_tokens: number | null
          posted_at: string | null
          prefilter_matched: string[] | null
          raw: Json | null
          reason: string | null
          score: number | null
          source: string
          suggested_reply: string | null
          title: string | null
          url: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_pending_leads: {
        Args: { batch_size: number }
        Returns: {
          author: string | null
          body: string | null
          category: string | null
          content_hash: string
          external_id: string | null
          feedback: string | null
          feedback_at: string | null
          first_seen_at: string
          id: number
          input_tokens: number | null
          lang: string | null
          last_seen_at: string
          llm_attempts: number
          llm_cost_usd: number | null
          llm_error: string | null
          llm_model: string | null
          llm_status: string
          notified_at: string | null
          notify_status: string
          output_tokens: number | null
          posted_at: string | null
          prefilter_matched: string[] | null
          raw: Json | null
          reason: string | null
          score: number | null
          source: string
          suggested_reply: string | null
          title: string | null
          url: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
