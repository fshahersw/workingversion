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
      cron_config: {
        Row: {
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      news_headlines: {
        Row: {
          category: string
          fetched_at: string
          id: string
          image_url: string | null
          published_at: string | null
          snippet: string | null
          source_domain: string | null
          title: string
          url: string
        }
        Insert: {
          category: string
          fetched_at?: string
          id?: string
          image_url?: string | null
          published_at?: string | null
          snippet?: string | null
          source_domain?: string | null
          title: string
          url: string
        }
        Update: {
          category?: string
          fetched_at?: string
          id?: string
          image_url?: string | null
          published_at?: string | null
          snippet?: string | null
          source_domain?: string | null
          title?: string
          url?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      research_conversations: {
        Row: {
          created_at: string
          id: string
          matter_id: string | null
          matter_label: string | null
          memory: Json
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          matter_id?: string | null
          matter_label?: string | null
          memory?: Json
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          matter_id?: string | null
          matter_label?: string | null
          memory?: Json
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      research_messages: {
        Row: {
          answer: string
          client_id: string | null
          conversation_id: string
          created_at: string
          followups: Json
          id: string
          role: string
          rounds: Json
          seq: number
          sources: Json
          text: string
          user_id: string
        }
        Insert: {
          answer?: string
          client_id?: string | null
          conversation_id: string
          created_at?: string
          followups?: Json
          id?: string
          role: string
          rounds?: Json
          seq?: number
          sources?: Json
          text?: string
          user_id: string
        }
        Update: {
          answer?: string
          client_id?: string | null
          conversation_id?: string
          created_at?: string
          followups?: Json
          id?: string
          role?: string
          rounds?: Json
          seq?: number
          sources?: Json
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "research_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      research_pins: {
        Row: {
          citation: string | null
          conversation_id: string | null
          created_at: string
          id: string
          matter_id: string | null
          note: string | null
          quote: string
          source_ref: string | null
          source_url: string | null
          user_id: string
        }
        Insert: {
          citation?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          matter_id?: string | null
          note?: string | null
          quote: string
          source_ref?: string | null
          source_url?: string | null
          user_id: string
        }
        Update: {
          citation?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          matter_id?: string | null
          note?: string | null
          quote?: string
          source_ref?: string | null
          source_url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_pins_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "research_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      research_prompts: {
        Row: {
          created_at: string
          id: string
          prompt: string
          title: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          prompt: string
          title: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          prompt?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      research_saved_answers: {
        Row: {
          answer: string
          conversation_id: string | null
          created_at: string
          id: string
          matter_id: string | null
          matter_label: string | null
          question: string
          sources: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          answer?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          matter_id?: string | null
          matter_label?: string | null
          question?: string
          sources?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          answer?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          matter_id?: string | null
          matter_label?: string | null
          question?: string
          sources?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_saved_answers_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "research_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      research_watch_hits: {
        Row: {
          created_at: string
          id: string
          published_at: string | null
          seen: boolean
          source_label: string | null
          summary: string | null
          title: string
          url: string | null
          user_id: string
          watch_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          published_at?: string | null
          seen?: boolean
          source_label?: string | null
          summary?: string | null
          title?: string
          url?: string | null
          user_id: string
          watch_id: string
        }
        Update: {
          created_at?: string
          id?: string
          published_at?: string | null
          seen?: boolean
          source_label?: string | null
          summary?: string | null
          title?: string
          url?: string | null
          user_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_watch_hits_watch_id_fkey"
            columns: ["watch_id"]
            isOneToOne: false
            referencedRelation: "research_watches"
            referencedColumns: ["id"]
          },
        ]
      }
      research_watches: {
        Row: {
          active: boolean
          created_at: string
          id: string
          label: string
          last_checked_at: string | null
          matter_id: string | null
          matter_label: string | null
          question: string
          seen_urls: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          label?: string
          last_checked_at?: string | null
          matter_id?: string | null
          matter_label?: string | null
          question: string
          seen_urls?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          label?: string
          last_checked_at?: string | null
          matter_id?: string | null
          matter_label?: string | null
          question?: string
          seen_urls?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      review_cell_history: {
        Row: {
          action: string
          actor_email: string | null
          cell_id: string
          created_at: string
          id: string
          next_display: string | null
          owner: string
          previous_display: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          cell_id: string
          created_at?: string
          id?: string
          next_display?: string | null
          owner: string
          previous_display?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          cell_id?: string
          created_at?: string
          id?: string
          next_display?: string | null
          owner?: string
          previous_display?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "review_cell_history_cell_id_fkey"
            columns: ["cell_id"]
            isOneToOne: false
            referencedRelation: "review_cells"
            referencedColumns: ["id"]
          },
        ]
      }
      review_cells: {
        Row: {
          cache_key: string | null
          citations: Json
          column_id: string
          confidence: string | null
          display: string
          error: string | null
          id: string
          overridden: boolean
          owner: string
          pages_searched: Json
          rationale: string | null
          row_id: string
          run_id: string | null
          status: string
          table_id: string
          updated_at: string
          value_json: Json | null
          verified_at: string | null
        }
        Insert: {
          cache_key?: string | null
          citations?: Json
          column_id: string
          confidence?: string | null
          display?: string
          error?: string | null
          id?: string
          overridden?: boolean
          owner: string
          pages_searched?: Json
          rationale?: string | null
          row_id: string
          run_id?: string | null
          status?: string
          table_id: string
          updated_at?: string
          value_json?: Json | null
          verified_at?: string | null
        }
        Update: {
          cache_key?: string | null
          citations?: Json
          column_id?: string
          confidence?: string | null
          display?: string
          error?: string | null
          id?: string
          overridden?: boolean
          owner?: string
          pages_searched?: Json
          rationale?: string | null
          row_id?: string
          run_id?: string | null
          status?: string
          table_id?: string
          updated_at?: string
          value_json?: Json | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "review_cells_column_id_fkey"
            columns: ["column_id"]
            isOneToOne: false
            referencedRelation: "review_columns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_cells_row_id_fkey"
            columns: ["row_id"]
            isOneToOne: false
            referencedRelation: "review_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_cells_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "review_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_cells_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "review_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      review_columns: {
        Row: {
          created_at: string
          id: string
          kind: string
          name: string
          options: Json
          owner: string
          position: number
          question: string
          table_id: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          name: string
          options?: Json
          owner: string
          position?: number
          question?: string
          table_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          name?: string
          options?: Json
          owner?: string
          position?: number
          question?: string
          table_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "review_columns_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "review_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      review_rows: {
        Row: {
          created_at: string
          file_ids: Json
          fingerprint: string | null
          id: string
          label: string
          owner: string
          page_count: number
          position: number
          table_id: string
        }
        Insert: {
          created_at?: string
          file_ids?: Json
          fingerprint?: string | null
          id?: string
          label: string
          owner: string
          page_count?: number
          position?: number
          table_id: string
        }
        Update: {
          created_at?: string
          file_ids?: Json
          fingerprint?: string | null
          id?: string
          label?: string
          owner?: string
          page_count?: number
          position?: number
          table_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_rows_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "review_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      review_runs: {
        Row: {
          cells_done: number
          cells_failed: number
          cells_total: number
          column_ids: Json
          finished_at: string | null
          id: string
          owner: string
          snapshot: Json
          started_at: string
          status: string
          table_id: string
        }
        Insert: {
          cells_done?: number
          cells_failed?: number
          cells_total?: number
          column_ids?: Json
          finished_at?: string | null
          id?: string
          owner: string
          snapshot?: Json
          started_at?: string
          status?: string
          table_id: string
        }
        Update: {
          cells_done?: number
          cells_failed?: number
          cells_total?: number
          column_ids?: Json
          finished_at?: string | null
          id?: string
          owner?: string
          snapshot?: Json
          started_at?: string
          status?: string
          table_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_runs_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "review_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      review_tables: {
        Row: {
          created_at: string
          id: string
          instructions: string | null
          matter_id: string | null
          matter_label: string | null
          name: string
          owner: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          instructions?: string | null
          matter_id?: string | null
          matter_label?: string | null
          name?: string
          owner: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          instructions?: string | null
          matter_id?: string | null
          matter_label?: string | null
          name?: string
          owner?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      trigger_calendar_sync: { Args: never; Returns: undefined }
      trigger_intel_run: { Args: never; Returns: undefined }
      verify_intel_cron_token: { Args: { token: string }; Returns: boolean }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
