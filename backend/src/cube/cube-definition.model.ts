// Ported from sco-ai-demo-builder create-cube skill (reference/cube-definition.model.ts).
// Types describing an IRIS Business Intelligence cube. Kept verbatim so cube
// authoring rules stay identical to the demo builder; only the generator that
// consumes these types was adapted for the backend.

export type DimensionType = 'data' | 'time' | 'age' | 'computed' | 'iKnow';
export type AggregateType = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';
export type MeasureType = 'integer' | 'number' | 'boolean' | 'string' | 'date' | 'age' | 'text' | 'iKnow';
export type TimeFunctionType =
  | 'Year' | 'QuarterYear' | 'MonthYear' | 'WeekYear'
  | 'MonthNumber' | 'DayMonthYear' | 'DayNumber' | 'Months';
export type CardinalityType = 'one' | 'many';
export type SelectModeType = 0 | 1 | 2;

export interface PropertyDef {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  sourceProperty?: string;
  factName?: string;
  hidden?: boolean;
  sort?: string;
  isName?: boolean;
  isDescription?: boolean;
  isReference?: boolean;
  useDisplayValue?: boolean;
  additionalDescription?: string;
}

export interface LevelDef {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  // one of sourceProperty or sourceExpression (not both)
  sourceProperty?: string;
  sourceExpression?: string;
  factNumber: number;
  list?: boolean;
  useDisplayValue?: boolean;
  useAsFilter?: boolean;
  hidden?: boolean;
  // time/age dimensions only
  timeFunction?: TimeFunctionType;
  // optional on any level
  nullReplacement?: string;
  rangeExpression?: string;
  // iKnow dimensions only
  dependsOn?: string;
  // optional on any level
  additionalDescription?: string;
  properties?: PropertyDef[];
}

export interface HierarchyDef {
  name?: string;       // defaults to "H1"
  displayName?: string;
  description?: string;
  disabled?: boolean;
  hidden?: boolean;
  additionalDescription?: string;
  levels: LevelDef[];
}

export interface CubeDimension {
  name: string;
  type: DimensionType;
  disabled?: boolean;
  hasAll?: boolean;
  allCaption?: string;       // defaults to "All {name}"
  allDisplayName?: string;   // defaults to "{name}"
  displayName?: string;
  description?: string;
  // optional on data dimensions, required on time/age dimensions
  sourceProperty?: string;
  calendar?: string;
  iKnowType?: string;
  hidden?: boolean;
  showHierarchies?: string;  // defaults to "default"
  hierarchies: HierarchyDef[];
}

export interface CubeMeasure {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  sourceProperty?: string;
  sourceExpression?: string;
  factName: string;
  aggregate: AggregateType;
  type: MeasureType;
  formatString?: string;
  hidden?: boolean;
  searchable?: boolean;
  listingFilterValue?: string;
  listingFilterOperator?: string;
  factNumber: number;
  additionalDescription?: string;
}

export interface CubeRelationship {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;        // defaults to true
  sourceProperty?: string;
  factName?: string;
  relatedCube: string;
  inverse: string;
  cardinality: CardinalityType;
  nullReplacement?: string;
  factNumber: number;
  additionalDescription?: string;
}

export interface CubeExpression {
  name: string;
  description?: string;
  disabled?: boolean;
  sourceExpression: string;
  additionalDescription?: string;
}

export interface CubeCalculatedMember {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  dimension: string;
  valueExpression: string;
  formatString?: string;
  hidden?: boolean;
  listingFilter?: string;
  additionalDescription?: string;
}

export interface CubeNamedSet {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  setExpression: string;
  additionalDescription?: string;
}

export interface CubeListing {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  listingType?: 'table' | 'map';  // defaults to "table"
  fieldList?: string;
  orderBy?: string;
  sql?: string;
  resource?: string;
  selectMode?: SelectModeType;
  additionalDescription?: string;
}

export interface CubeListingField {
  name: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
  fieldExpression: string;
  resource?: string;
}

export interface CubeDefinition {
  // Maps to: Class name segment + DependsOn
  cubeName: string;
  sourceClass: string;

  // Class-level description  → /// {description} before Class line
  description?: string;

  // <cube> attributes — optional ones are omitted if not provided
  displayName?: string;         // defaults to cubeName in output
  disabled?: boolean;           // default false
  abstract?: boolean;           // default false
  namedFactNums?: boolean;      // default true
  countMeasureName?: string;    // default "%COUNT"
  bucketSize?: number;          // default 8
  bitmapChunkInMemory?: boolean; // default false
  defaultListing?: string;      // omitted if not provided
  precompute?: number;          // default 0
  disableListingGroups?: boolean; // default false
  enableSqlRestrict?: boolean;  // default false

  dimensions?: CubeDimension[];
  measures?: CubeMeasure[];
  relationships?: CubeRelationship[];
  expressions?: CubeExpression[];
  calculatedMembers?: CubeCalculatedMember[];
  namedSets?: CubeNamedSet[];
  listings?: CubeListing[];
  listingFields?: CubeListingField[];
}
