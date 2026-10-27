import type { ScenarioPackage } from "./contracts.js";
export const adventure: ScenarioPackage = {
  kind: "scenario",
  id: "lantern-vault",
  version: "2.0.0",
  name: "雾灯地窖 · 完整冒险",
  description: "调查铜铃、与守卫交涉或战斗、修复并点亮灯塔的原创冒险。",
  startLocation: "雾灯镇 · 废弃灯塔入口",
  startSceneId: "entrance",
  scenes: [
    {
      id: "entrance",
      name: "灯塔入口",
      description: "湿石阶旁挂着熄灭的铁灯。",
      links: ["cellar"],
      npcs: [
        {
          name: "码头信使",
          description: "请求找回灯光的年轻信使。",
        },
      ],
      entryCondition: {
        type: "always",
      },
      revealCondition: null,
    },
    {
      id: "cellar",
      name: "潮湿地窖",
      description: "木架与齿轮守卫挡住长廊。",
      links: ["entrance", "beacon"],
      npcs: [
        {
          name: "齿轮守卫",
          description: "循着声响转动的铜制守卫。",
        },
      ],
      entryCondition: {
        type: "always",
      },
      revealCondition: null,
    },
    {
      id: "beacon",
      name: "蓝灯室",
      description: "裂窗后的灯芯仍有微光，墙上刻着旧约。",
      links: ["cellar"],
      npcs: [],
      entryCondition: {
        type: "always",
      },
      revealCondition: null,
    },
  ],
  opening:
    "暴风将至，码头信使请你点亮灯塔，为归航渔船指路。入口有一只旧箱，信使正在等候。你可以调查旧箱、询问信使，或进入地窖。",
  secrets: ["守灯人藏在第二道门后，铜铃是停下守卫的钥匙。"],
  personalSecrets: ["你认得入口的旧商会标志。", "你曾见过相似的灯塔图案。"],
  story: {
    flags: ["bell-found", "guard-cleared", "wick-fixed"],
    items: [
      {
        id: "bell",
        name: "铜铃",
      },
    ],
    objectives: [
      {
        id: "find-bell",
        text: "调查入口并寻找可用物品",
      },
      {
        id: "pass-guard",
        text: "通过地窖守卫",
      },
      {
        id: "repair-wick",
        text: "修复灯芯",
      },
      {
        id: "light-beacon",
        text: "点亮灯塔",
      },
    ],
    endings: [
      {
        id: "light",
        title: "归航之灯",
        text: "蓝灯穿透浓雾，渔船沿光返港。守灯人的旧约得到延续；信使向你致谢。冒险完成。",
        status: "won",
      },
      {
        id: "retreat",
        title: "雾中撤退",
        text: "你选择返回码头求援。今夜灯塔仍然漆黑，渔船转向避风港；本次任务失败，但队伍保住了性命。",
        status: "lost",
      },
      {
        id: "defeat",
        title: "灯火未明",
        text: "队伍在守卫前倒下，信使带来救援。灯塔未能及时点亮，本次冒险失败。",
        status: "lost",
      },
    ],
    encounters: [
      {
        id: "gear-guard",
        name: "齿轮守卫",
        hp: 18,
        maxHp: 18,
        ac: 11,
        bonus: 2,
        stamina: 99,
      },
    ],
    initialPaths: [
      {
        from: "entrance",
        to: "cellar",
      },
      {
        from: "cellar",
        to: "entrance",
      },
      {
        from: "beacon",
        to: "cellar",
      },
    ],
    interactions: [
      {
        id: "search-box",
        sceneId: "entrance",
        label: "调查旧箱",
        description: "调查旧箱",
        aliases: ["调查入口", "调查旧箱", "搜索旧箱", "打开箱子", "查看箱子"],
        conditions: [
          {
            type: "flag",
            id: "bell-found",
            value: false,
          },
        ],
        check: null,
        effects: [
          {
            type: "flag",
            id: "bell-found",
            value: true,
          },
          {
            type: "item",
            id: "bell",
            quantity: 1,
          },
          {
            type: "objective",
            id: "find-bell",
          },
          {
            type: "reveal",
            text: "旧箱里有一枚铜铃，箱盖写着：三声铃响，守卫止戈。",
            audience: "public",
          },
        ],
        failureEffects: [],
      },
      {
        id: "ask-messenger",
        sceneId: "entrance",
        label: "询问信使",
        description: "询问信使",
        aliases: ["询问信使", "和信使交谈", "询问线索"],
        conditions: [],
        check: null,
        effects: [
          {
            type: "reveal",
            text: "信使说：先查看入口旧箱。守卫听得懂古老的停战铃声；若无铃，也可以直接请求通行。",
            audience: "public",
          },
        ],
        failureEffects: [],
      },
      {
        id: "ring-bell",
        sceneId: "cellar",
        label: "摇响铜铃",
        description: "摇响铜铃",
        aliases: ["摇铃", "摇响铜铃", "敲响铜铃", "摇三声铜铃"],
        conditions: [
          {
            type: "flag",
            id: "guard-cleared",
            value: false,
          },
          {
            type: "item",
            id: "bell",
            quantity: 1,
          },
        ],
        check: null,
        effects: [
          {
            type: "flag",
            id: "guard-cleared",
            value: true,
          },
          {
            type: "reveal",
            text: "三声铜铃响过，守卫垂下武器，打开蓝灯室的门。",
            audience: "public",
          },
        ],
        failureEffects: [],
      },
      {
        id: "negotiate",
        sceneId: "cellar",
        label: "请求守卫通行",
        description: "请求守卫通行",
        aliases: ["请求通行", "说服守卫", "与守卫交涉", "请求守卫通行"],
        conditions: [
          {
            type: "flag",
            id: "guard-cleared",
            value: false,
          },
        ],
        check: {
          dc: 12,
          cost: 1,
        },
        effects: [
          {
            type: "flag",
            id: "guard-cleared",
            value: true,
          },
          {
            type: "reveal",
            text: "守卫接受救助渔船的理由，准许通行。",
            audience: "public",
          },
        ],
        failureEffects: [
          {
            type: "reveal",
            text: "守卫尚不相信你。你可以再次交涉、寻找铜铃，或挑战守卫；失败不会封死通道。",
            audience: "public",
          },
        ],
      },
      {
        id: "challenge-guard",
        sceneId: "cellar",
        label: "挑战守卫",
        description: "挑战守卫",
        aliases: ["挑战守卫", "攻击守卫", "攻击齿轮守卫", "开战"],
        conditions: [
          {
            type: "flag",
            id: "guard-cleared",
            value: false,
          },
        ],
        check: null,
        effects: [
          {
            type: "encounter",
            id: "gear-guard",
          },
        ],
        failureEffects: [],
      },
      {
        id: "repair-wick",
        sceneId: "beacon",
        label: "修复灯芯",
        description: "修复灯芯",
        aliases: ["修复灯芯", "修理灯芯", "修灯芯"],
        conditions: [
          {
            type: "flag",
            id: "wick-fixed",
            value: false,
          },
        ],
        check: {
          dc: 10,
          cost: 1,
        },
        effects: [
          {
            type: "flag",
            id: "wick-fixed",
            value: true,
          },
          {
            type: "objective",
            id: "repair-wick",
          },
          {
            type: "reveal",
            text: "你重新接好灯芯，灯油开始沿棉线渗出。",
            audience: "public",
          },
        ],
        failureEffects: [
          {
            type: "reveal",
            text: "灯芯打滑，暂未接好。工具仍可用；你可以休整后重试。",
            audience: "public",
          },
        ],
      },
      {
        id: "light-lamp",
        sceneId: "beacon",
        label: "点亮蓝灯",
        description: "点亮蓝灯",
        aliases: ["点灯", "点亮蓝灯", "点亮灯塔"],
        conditions: [
          {
            type: "flag",
            id: "wick-fixed",
            value: true,
          },
        ],
        check: null,
        effects: [
          {
            type: "objective",
            id: "light-beacon",
          },
          {
            type: "ending",
            id: "light",
          },
        ],
        failureEffects: [],
      },
    ],
    triggers: [
      {
        id: "guard-victory",
        once: true,
        conditions: [
          {
            type: "enemy",
            id: "gear-guard",
            defeated: true,
          },
          {
            type: "flag",
            id: "guard-cleared",
            value: false,
          },
        ],
        effects: [
          {
            type: "flag",
            id: "guard-cleared",
            value: true,
          },
          {
            type: "reveal",
            text: "守卫的齿轮停止转动，通往蓝灯室的门锁松开。",
            audience: "public",
          },
        ],
      },
      {
        id: "open-beacon",
        once: true,
        conditions: [
          {
            type: "flag",
            id: "guard-cleared",
            value: true,
          },
        ],
        effects: [
          {
            type: "path",
            from: "cellar",
            to: "beacon",
          },
          {
            type: "objective",
            id: "pass-guard",
          },
        ],
      },
    ],
  },
};
