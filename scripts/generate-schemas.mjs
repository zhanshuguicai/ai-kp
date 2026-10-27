import { mkdir, writeFile } from "node:fs/promises";
const text = { type: "string", minLength: 1, maxLength: 4000 };
const short = { type: "string", minLength: 1, maxLength: 100 };
const id = { type: "string", pattern: "^[a-z0-9-]{1,60}$" };
const list = { type: "array", maxItems: 100, items: text };
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const common = {
  id,
  version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
  name: short,
  description: { ...text, maxLength: 2000 },
};
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const rules = obj({
  ...common,
  kind: { const: "rules" },
  engine: { const: "simple-d20-v1" },
  parameters: obj({
    defaultDc: integer(5, 25),
    maxStamina: integer(1, 30),
    damageSides: integer(2, 20),
    damageBonus: integer(0, 10),
  }),
  supported: list,
  unsupported: list,
});
const scene = obj({
  id,
  name: short,
  description: text,
  links: { type: "array", items: id },
  npcs: {
    type: "array",
    items: obj({ name: short, description: { ...text, maxLength: 1000 } }),
  },
  entryCondition: obj({ type: { const: "always" } }),
  revealCondition: {
    oneOf: [
      { type: "null" },
      obj({
        type: { const: "planned" },
        description: { ...text, maxLength: 2000 },
      }),
    ],
  },
});
const scenario = obj({
  ...common,
  kind: { const: "scenario" },
  startLocation: { ...text, maxLength: 200 },
  startSceneId: id,
  scenes: { type: "array", minItems: 1, maxItems: 30, items: scene },
  opening: text,
  secrets: list,
  personalSecrets: list,
});
// v0.2 optional story definition; v1 required fields remain compatible.
scenario.properties.story = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "string",
        pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
      },
      maxItems: 100,
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
        },
        required: ["id", "name"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    objectives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    endings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
          status: {
            enum: ["won", "lost"],
          },
        },
        required: ["id", "title", "text", "status"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    encounters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
          hp: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
          },
          maxHp: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
          },
          ac: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          bonus: {
            type: "integer",
            minimum: -20,
            maximum: 100,
          },
          stamina: {
            type: "integer",
            minimum: 0,
            maximum: 1000,
          },
        },
        required: ["id", "name", "hp", "maxHp", "ac", "bonus", "stamina"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    initialPaths: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          to: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    interactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          sceneId: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          label: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
          description: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
          },
          aliases: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
              maxLength: 4000,
            },
            maxItems: 20,
          },
          conditions: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "scene",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "target",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "action",
                    },
                    kind: {
                      enum: [
                        "check",
                        "attack",
                        "end_turn",
                        "move",
                        "interact",
                        "rest",
                        "retreat",
                      ],
                    },
                  },
                  required: ["type", "kind"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "flag",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    value: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "value"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "item",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    quantity: {
                      type: "integer",
                      minimum: 1,
                      maximum: 999,
                    },
                  },
                  required: ["type", "id", "quantity"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "check",
                    },
                    success: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "success"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "enemy",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    defeated: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "defeated"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "status",
                    },
                    value: {
                      enum: ["active", "won", "lost"],
                    },
                  },
                  required: ["type", "value"],
                  additionalProperties: false,
                },
              ],
            },
            maxItems: 30,
          },
          check: {
            oneOf: [
              {
                type: "null",
              },
              {
                type: "object",
                properties: {
                  dc: {
                    type: "integer",
                    minimum: 5,
                    maximum: 25,
                  },
                  cost: {
                    type: "integer",
                    minimum: 0,
                    maximum: 30,
                  },
                },
                required: ["dc", "cost"],
                additionalProperties: false,
              },
            ],
          },
          effects: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "flag",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    value: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "value"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "item",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    quantity: {
                      type: "integer",
                      minimum: -99,
                      maximum: 99,
                      not: {
                        const: 0,
                      },
                    },
                  },
                  required: ["type", "id", "quantity"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "reveal",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4000,
                    },
                    audience: {
                      enum: ["public", "actor"],
                    },
                  },
                  required: ["type", "text", "audience"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "path",
                    },
                    from: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    to: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "from", "to"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "objective",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "encounter",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "end_encounter",
                    },
                  },
                  required: ["type"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "ending",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
              ],
            },
            maxItems: 30,
          },
          failureEffects: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "flag",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    value: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "value"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "item",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    quantity: {
                      type: "integer",
                      minimum: -99,
                      maximum: 99,
                      not: {
                        const: 0,
                      },
                    },
                  },
                  required: ["type", "id", "quantity"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "reveal",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4000,
                    },
                    audience: {
                      enum: ["public", "actor"],
                    },
                  },
                  required: ["type", "text", "audience"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "path",
                    },
                    from: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    to: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "from", "to"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "objective",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "encounter",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "end_encounter",
                    },
                  },
                  required: ["type"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "ending",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
              ],
            },
            maxItems: 30,
          },
        },
        required: [
          "id",
          "sceneId",
          "label",
          "description",
          "aliases",
          "conditions",
          "check",
          "effects",
          "failureEffects",
        ],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    triggers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
          },
          once: {
            type: "boolean",
          },
          conditions: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "scene",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "target",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "action",
                    },
                    kind: {
                      enum: [
                        "check",
                        "attack",
                        "end_turn",
                        "move",
                        "interact",
                        "rest",
                        "retreat",
                      ],
                    },
                  },
                  required: ["type", "kind"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "flag",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    value: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "value"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "item",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    quantity: {
                      type: "integer",
                      minimum: 1,
                      maximum: 999,
                    },
                  },
                  required: ["type", "id", "quantity"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "check",
                    },
                    success: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "success"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "enemy",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    defeated: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "defeated"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "status",
                    },
                    value: {
                      enum: ["active", "won", "lost"],
                    },
                  },
                  required: ["type", "value"],
                  additionalProperties: false,
                },
              ],
            },
            maxItems: 30,
          },
          effects: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "flag",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    value: {
                      type: "boolean",
                    },
                  },
                  required: ["type", "id", "value"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "item",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    quantity: {
                      type: "integer",
                      minimum: -99,
                      maximum: 99,
                      not: {
                        const: 0,
                      },
                    },
                  },
                  required: ["type", "id", "quantity"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "reveal",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4000,
                    },
                    audience: {
                      enum: ["public", "actor"],
                    },
                  },
                  required: ["type", "text", "audience"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "path",
                    },
                    from: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                    to: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "from", "to"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "objective",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "encounter",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "end_encounter",
                    },
                  },
                  required: ["type"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      const: "ending",
                    },
                    id: {
                      type: "string",
                      pattern:
                        "^(?!constructor$|prototype$|__proto__$)[a-z0-9-]{1,60}$",
                    },
                  },
                  required: ["type", "id"],
                  additionalProperties: false,
                },
              ],
            },
            maxItems: 30,
          },
        },
        required: ["id", "once", "conditions", "effects"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
  },
  required: [
    "flags",
    "items",
    "objectives",
    "endings",
    "encounters",
    "initialPaths",
    "interactions",
    "triggers",
  ],
  additionalProperties: false,
};
await mkdir("schemas", { recursive: true });
for (const [name, schema] of [
  ["rules", rules],
  ["scenario", scenario],
  [
    "package",
    {
      oneOf: [{ $ref: "rules.schema.json" }, { $ref: "scenario.schema.json" }],
    },
  ],
])
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(
      { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema },
      null,
      2,
    ),
  );
console.log(
  "3 schemas generated. Graph references and unique scene IDs are additionally validated by the server.",
);
