export type FieldScope = 'inquiry' | 'inventory' | 'supplier';
export type FieldType = 'text' | 'number' | 'date' | 'enum' | 'bool';
export interface FieldDef { key: string; label: string; scope: FieldScope; type: FieldType; builtin?: boolean; required?: boolean; options?: string[]; aliases?: [string, string][]; min?: number; max?: number; pattern?: string; mapTarget?: boolean; aiExtract?: boolean; exportVisible?: boolean; customerVisible?: boolean; order?: number; }
export interface FieldSchema { version: number; industry: string; fields: FieldDef[]; certificates?: { name: string; pattern: string }[]; }
export const DEFAULT_FIELDS: FieldDef[];
export const DEFAULT_SCHEMA: FieldSchema;
export const INDUSTRY_TEMPLATES: Record<string, { label: string; fields: FieldDef[] }>;
export function normalizeSchema(saved: unknown): FieldSchema;
export function applyTemplate(schema: FieldSchema, industry: string): FieldSchema;
export function fieldsFor(schema: FieldSchema | undefined, scope: FieldScope, opt?: { stage?: 'map' | 'ai' | 'export' | 'customer'; customOnly?: boolean }): FieldDef[];
export function labelOf(schema: FieldSchema | undefined, key: string): string;
export function dynamicAliases(schema: FieldSchema | undefined, scope: FieldScope): Record<string, string>;
export function validateValue(def: FieldDef, value: unknown): string[];
export function validateCustomFields(schema: FieldSchema | undefined, scope: FieldScope, values: Record<string, unknown> | undefined): string[];
export function schemaPrompt(schema: FieldSchema | undefined, scope: FieldScope): string;
export function customFieldDefs(schema: FieldSchema | undefined, scope: FieldScope): FieldDef[];
export function splitCustomKeys(schema: FieldSchema | undefined, scope: FieldScope, row: Record<string, unknown>): { core: Record<string, unknown>; custom: Record<string, unknown> };
export function conditionRequired(schema: FieldSchema | undefined): boolean;
export function allowedUnitsFor(schema: FieldSchema | undefined): string[];
export function condAliasesFor(schema: FieldSchema | undefined, condAliases?: [string, string][]): [string, string][];
export function conditionCodesFor(schema: FieldSchema | undefined, condAliases?: [string, string][]): string[];
export const DEFAULT_CERTIFICATES: { name: string; pattern: string }[];
export function certificatesFor(schema: FieldSchema | undefined): { name: string; pattern: string }[];
