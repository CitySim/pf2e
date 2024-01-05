import { ActorPF2e } from "@actor";
import { TraitViewData } from "@actor/data/base.ts";
import type { CheckModifier } from "@actor/modifiers.ts";
import { RollTarget } from "@actor/types.ts";
import { createActionRangeLabel } from "@item/ability/helpers.ts";
import { reduceItemName } from "@item/helpers.ts";
import { ChatMessageSourcePF2e, CheckRollContextFlag, TargetFlag } from "@module/chat-message/data.ts";
import { isCheckContextFlag } from "@module/chat-message/helpers.ts";
import { ChatMessagePF2e } from "@module/chat-message/index.ts";
import { RollNotePF2e } from "@module/notes.ts";
import { TokenDocumentPF2e, type ScenePF2e } from "@scene";
import { eventToRollParams } from "@scripts/sheet-util.ts";
import { StatisticDifficultyClass } from "@system/statistic/index.ts";
import {
    ErrorPF2e,
    createHTMLElement,
    fontAwesomeIcon,
    htmlQuery,
    htmlQueryAll,
    objectHasKey,
    parseHTML,
    signedInteger,
    sluggify,
    traitSlugToObject,
} from "@util";
import * as R from "remeda";
import {
    DEGREE_OF_SUCCESS_STRINGS,
    DegreeAdjustmentsRecord,
    DegreeOfSuccess,
    DegreeOfSuccessString,
} from "../degree-of-success.ts";
import { TextEditorPF2e } from "../text-editor.ts";
import { CheckModifiersDialog } from "./dialog.ts";
import { CheckRoll, CheckRollDataPF2e } from "./roll.ts";
import { CheckRollContext } from "./types.ts";

interface RerollOptions {
    heroPoint?: boolean;
    keep?: "new" | "higher" | "lower";
}

type CheckRollCallback = (
    roll: Rolled<CheckRoll>,
    outcome: DegreeOfSuccessString | null | undefined,
    message: ChatMessagePF2e,
    event: Event | null,
) => Promise<void> | void;

class CheckPF2e {
    /** Roll the given statistic, optionally showing the check modifier dialog if 'Shift' is held down. */
    static async roll(
        check: CheckModifier,
        context: CheckRollContext = {},
        event: JQuery.TriggeredEvent | Event | null = null,
        callback?: CheckRollCallback,
    ): Promise<Rolled<CheckRoll> | null> {
        // If event is supplied, merge into context
        // Eventually the event parameter will go away entirely
        if (event) fu.mergeObject(context, eventToRollParams(event, { type: "check" }));
        context.skipDialog ??= !game.user.settings.showCheckDialogs;
        context.createMessage ??= true;

        // System code must pass a set, but macros and modules may instead pass an array
        if (Array.isArray(context.options)) context.options = new Set(context.options);
        const rollOptions = context.options ?? new Set();
        if (typeof context.mapIncreases === "number") {
            rollOptions.add(`map:increases:${context.mapIncreases}`);
        }

        // Figure out the default roll mode (if not already set by the event)
        if (rollOptions.has("secret")) context.rollMode ??= game.user.isGM ? "gmroll" : "blindroll";
        context.rollMode ??= "roll";

        if (rollOptions.size > 0 && !context.isReroll) {
            check.calculateTotal(rollOptions);
        }

        const substitutions = (context.substitutions ??= []);
        const requiredSubstitution = context.substitutions.find((s) => s.required && s.selected);
        if (requiredSubstitution) {
            for (const substitution of context.substitutions) {
                substitution.required = substitution === requiredSubstitution;
                substitution.selected = substitution === requiredSubstitution;
            }
        }

        if (!context.skipDialog && context.type !== "flat-check") {
            // Show dialog for adding/editing modifiers, unless skipped or flat check
            const dialogClosed = new Promise((resolve: (value: boolean) => void) => {
                new CheckModifiersDialog(check, resolve, context).render(true);
            });
            const rolled = await dialogClosed;
            if (!rolled) return null;
        }

        const extraTags: string[] = [];
        const isReroll = context.isReroll ?? false;
        if (isReroll) context.rollTwice = false;

        // Acquire the d20 roll expression and resolve fortune/misfortune effects
        const [dice, tagsFromDice] = ((): [string, string[]] => {
            const substitution = substitutions.find((s) => s.selected);
            const rollTwice = context.rollTwice ?? false;

            // Determine whether both fortune and misfortune apply to the check
            const fortuneMisfortune = new Set(
                R.compact([
                    substitution?.effectType,
                    rollTwice === "keep-higher" ? "fortune" : rollTwice === "keep-lower" ? "misfortune" : null,
                ]),
            );
            for (const trait of fortuneMisfortune) {
                rollOptions.add(trait);
            }

            if (rollOptions.has("fortune") && rollOptions.has("misfortune")) {
                for (const sub of substitutions) {
                    // Cancel all roll substitutions and recalculate
                    rollOptions.delete(`substitute:${sub.slug}`);
                    check.calculateTotal(rollOptions);
                }

                return ["1d20", ["PF2E.TraitFortune", "PF2E.TraitMisfortune"]];
            } else if (substitution) {
                const effectType = {
                    fortune: "PF2E.TraitFortune",
                    misfortune: "PF2E.TraitMisfortune",
                }[substitution.effectType];
                const extraTag = game.i18n.format("PF2E.SpecificRule.SubstituteRoll.EffectType", {
                    type: game.i18n.localize(effectType),
                    substitution: reduceItemName(game.i18n.localize(substitution.label)),
                });

                return [substitution.value.toString(), [extraTag]];
            } else if (context.rollTwice === "keep-lower") {
                return ["2d20kl", ["PF2E.TraitMisfortune"]];
            } else if (context.rollTwice === "keep-higher") {
                return ["2d20kh", ["PF2E.TraitFortune"]];
            } else {
                return ["1d20", []];
            }
        })();
        extraTags.push(...tagsFromDice);

        const options: CheckRollDataPF2e = {
            type: context.type,
            identifier: context.identifier,
            action: context.action ? sluggify(context.action) || null : null,
            domains: context.domains,
            isReroll,
            totalModifier: check.totalModifier,
            damaging: !!context.damaging,
            rollerId: game.userId,
            showBreakdown:
                context.type === "flat-check" ||
                game.pf2e.settings.metagame.breakdowns ||
                !!context.actor?.hasPlayerOwner,
        };

        const totalModifierPart = signedInteger(check.totalModifier, { emptyStringZero: true });
        const roll = await new CheckRoll(`${dice}${totalModifierPart}`, {}, options).evaluate({ async: true });

        // Combine all degree of success adjustments into a single record. Some may be overridden, but that should be
        // rare--and there are no rules for selecting among multiple adjustments.
        const dosAdjustments = ((): DegreeAdjustmentsRecord => {
            if (R.isNil(context.dc)) return {};

            const naturalTotal = R.compact(
                roll.dice.map((d) => d.results.find((r) => r.active && !r.discarded)?.result ?? null),
            ).shift();

            // Include tentative results in case an adjustment is predicated on it
            const temporaryRollOptions = new Set([
                ...rollOptions,
                `check:total:${roll.total}`,
                `check:total:natural:${naturalTotal}`,
            ]);

            return (
                context.dosAdjustments
                    ?.filter((a) => a.predicate?.test(temporaryRollOptions) ?? true)
                    .reduce((record, data) => {
                        for (const outcome of ["all", ...DEGREE_OF_SUCCESS_STRINGS] as const) {
                            if (data.adjustments[outcome]) {
                                record[outcome] = fu.deepClone(data.adjustments[outcome]);
                            }
                        }
                        return record;
                    }, {} as DegreeAdjustmentsRecord) ?? {}
            );
        })();
        const degree = context.dc ? new DegreeOfSuccess(roll, context.dc, dosAdjustments) : null;

        if (degree) {
            context.outcome = DEGREE_OF_SUCCESS_STRINGS[degree.value];
            context.unadjustedOutcome = DEGREE_OF_SUCCESS_STRINGS[degree.unadjusted];
            roll.options.degreeOfSuccess = degree.value;
        }

        const notes =
            context.notes
                ?.map((n) => (n instanceof RollNotePF2e ? n : new RollNotePF2e(n)))
                .filter((note) => {
                    if (!note.predicate.test([...rollOptions, ...(note.rule?.item.getRollOptions("parent") ?? [])])) {
                        return false;
                    }
                    if (!context.dc || note.outcome.length === 0) {
                        // Always show the note if the check has no DC or no outcome is specified.
                        return true;
                    }
                    const outcome = context.outcome ?? context.unadjustedOutcome;
                    return !!(outcome && note.outcome.includes(outcome));
                }) ?? [];
        const notesList = RollNotePF2e.notesToHTML(notes);

        const item = context.item ?? null;

        const flavor = await (async (): Promise<string> => {
            const result = await this.#createResultFlavor({ degree, target: context.target ?? null });
            const tags = this.#createTagFlavor({ check, context, extraTags });
            const title = (context.title ?? check.slug).trim();
            const header = title.startsWith("<h4")
                ? title
                : ((): HTMLElement => {
                      const strong = document.createElement("strong");
                      strong.innerHTML = title;
                      return createHTMLElement("h4", { classes: ["action"], children: [strong] });
                  })();

            return [header, result ?? [], tags, notesList]
                .flat()
                .map((e) => (typeof e === "string" ? e : e.outerHTML))
                .join("");
        })();

        const contextFlag: CheckRollContextFlag = {
            ...context,
            type: context.type ?? "check",
            identifier: context.identifier ?? null,
            item: undefined,
            dosAdjustments,
            actor: context.actor?.id ?? null,
            token: context.token?.id ?? null,
            domains: context.domains ?? [],
            target: context.target ? { actor: context.target.actor.uuid, token: context.target.token.uuid } : null,
            options: Array.from(rollOptions).sort(),
            notes: notes.map((n) => n.toObject()),
            rollMode: context.rollMode,
            rollTwice: context.rollTwice ?? false,
            title: context.title ?? "PF2E.Check.Label",
            traits: context.traits ?? [],
            substitutions,
            dc: context.dc ? R.omit(context.dc, ["statistic"]) : null,
            skipDialog: context.skipDialog,
            isReroll: context.isReroll ?? false,
            outcome: context.outcome ?? null,
            unadjustedOutcome: context.unadjustedOutcome ?? null,
        };
        delete contextFlag.item;

        type MessagePromise = Promise<ChatMessagePF2e | ChatMessageSourcePF2e>;
        const message = await ((): MessagePromise => {
            const flags = {
                core: context.type === "initiative" ? { initiativeRoll: true } : {},
                pf2e: {
                    context: contextFlag,
                    modifierName: check.slug,
                    modifiers: check.modifiers.map((m) => m.toObject()),
                    origin: item?.getOriginData(),
                },
            };

            const speaker = ChatMessagePF2e.getSpeaker({ actor: context.actor, token: context.token });
            const rollMode = contextFlag.rollMode;
            const create = context.createMessage;

            return roll.toMessage({ speaker, flavor, flags }, { rollMode, create }) as MessagePromise;
        })();

        if (callback) {
            const msg = message instanceof ChatMessagePF2e ? message : new ChatMessagePF2e(message);
            const evt = !!event && event instanceof Event ? event : event?.originalEvent ?? null;
            await callback(roll, context.outcome, msg, evt);
        }

        // Consume one unit of the weapon if it has the consumable trait
        const isConsumableWeapon = item?.isOfType("weapon") && item.traits.has("consumable");
        if (isConsumableWeapon && item.actor.items.has(item.id) && item.quantity > 0) {
            await item.update({ system: { quantity: item.quantity - 1 } });
        }

        return roll;
    }

    static #createTagFlavor({ check, context, extraTags }: CreateTagFlavorParams): HTMLElement[] {
        interface TagObject {
            label: string;
            name?: string;
            description?: string;
        }

        const toTagElement = (tag: TagObject, cssClass: string | null = null): HTMLElement => {
            const span = document.createElement("span");
            span.classList.add("tag");
            if (cssClass) span.classList.add(`tag_${cssClass}`);

            span.innerText = tag.label;

            if (tag.name) span.dataset.slug = tag.name;
            if (tag.description) span.dataset.tooltip = tag.description;

            return span;
        };

        const traits =
            R.uniqBy(
                context.traits
                    ?.map((t) => traitSlugToObject(t, CONFIG.PF2E.actionTraits))
                    .map((trait) => {
                        trait.label = game.i18n.localize(trait.label);
                        return trait;
                    }) ?? [],
                (t) => t.name,
            )
                .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang))
                .map((t) => toTagElement(t)) ?? [];

        const item = context.item;
        const itemTraits =
            item?.isOfType("weapon", "melee") && context.type !== "saving-throw"
                ? Array.from(item.traits)
                      .map((t): TraitViewData => {
                          const dictionary = item.isOfType("spell")
                              ? CONFIG.PF2E.spellTraits
                              : CONFIG.PF2E.npcAttackTraits;
                          const obj = traitSlugToObject(t, dictionary);
                          obj.label = game.i18n.localize(obj.label);
                          return obj;
                      })
                      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang))
                      .map((t): HTMLElement => toTagElement(t, "alt"))
                : [];

        const properties = ((): HTMLElement[] => {
            const range = item?.isOfType("action", "weapon") ? item.range : null;
            const label = createActionRangeLabel(range);
            if (label && (range?.increment || range?.max)) {
                // Show the range increment or max range as a tag
                const slug = range.increment ? `range-increment-${range.increment}` : `range-${range.max}`;
                const description = "PF2E.Item.Weapon.RangeIncrementN.Hint";
                return [toTagElement({ name: slug, label, description }, "secondary")];
            } else {
                return [];
            }
        })();

        const traitsAndProperties = createHTMLElement("div", {
            classes: ["tags", "traits"],
            dataset: { tooltipClass: "pf2e" },
        });
        if (itemTraits.length === 0 && properties.length === 0) {
            traitsAndProperties.append(...traits);
        } else {
            const verticalBar = document.createElement("hr");
            verticalBar.className = "vr";
            traitsAndProperties.append(...[traits, verticalBar, itemTraits, properties].flat());
        }

        const showBreakdown = game.pf2e.settings.metagame.breakdowns || !!context.actor?.hasPlayerOwner;
        const modifiers = check.modifiers
            .filter((m) => m.enabled)
            .map((modifier) => {
                const sign = modifier.modifier < 0 ? "" : "+";
                const label = `${modifier.label} ${sign}${modifier.modifier}`;
                const tag = toTagElement({ name: modifier.slug, label }, "transparent");
                if (!showBreakdown) tag.dataset.visibility = "gm";
                return tag;
            });
        const tagsFromOptions = extraTags.map((t) => toTagElement({ label: game.i18n.localize(t) }, "transparent"));
        const rollTags = [...modifiers, ...tagsFromOptions];
        const modifiersAndExtras =
            rollTags.length > 0
                ? createHTMLElement("div", { classes: ["tags", "modifiers"], children: rollTags })
                : null;

        return R.compact([
            traitsAndProperties.childElementCount > 0 ? traitsAndProperties : null,
            document.createElement("hr"),
            modifiersAndExtras,
        ]);
    }

    /** Reroll a rolled check given a chat message. */
    static async rerollFromMessage(
        message: ChatMessagePF2e,
        { heroPoint = false, keep = "new" }: RerollOptions = {},
    ): Promise<void> {
        if (!(message.isAuthor || game.user.isGM)) {
            ui.notifications.error(game.i18n.localize("PF2E.RerollMenu.ErrorCantDelete"));
            return;
        }

        const actor = game.actors.get(message.speaker.actor ?? "");
        let rerollFlavor = game.i18n.localize(`PF2E.RerollMenu.MessageKeep.${keep}`);
        if (heroPoint) {
            // If the reroll costs a hero point, first check if the actor has one to spare and spend it
            if (actor?.isOfType("character")) {
                const heroPointCount = actor.heroPoints.value;
                if (heroPointCount) {
                    await actor.update({
                        "system.resources.heroPoints.value": Math.clamped(heroPointCount - 1, 0, actor.heroPoints.max),
                    });
                    rerollFlavor = game.i18n.format("PF2E.RerollMenu.MessageHeroPoint", { name: actor.name });
                } else {
                    ui.notifications.warn(game.i18n.format("PF2E.RerollMenu.WarnNoHeroPoint", { name: actor.name }));
                    return;
                }
            } else {
                ui.notifications.error("PF2E.RerollMenu.ErrorNoActor", { localize: true });
                return;
            }
        }

        const systemFlags = fu.deepClone(message.flags.pf2e);
        const context = systemFlags.context;
        if (!isCheckContextFlag(context)) return;

        context.skipDialog = true;
        context.isReroll = true;

        const oldRoll = message.rolls.at(0);
        if (!(oldRoll instanceof CheckRoll)) throw ErrorPF2e("Unexpected error retrieving prior roll");

        // Clone the old roll and call a hook allowing the clone to be altered.
        // Tampering with the old roll is disallowed.
        const unevaluatedNewRoll = oldRoll.clone();
        unevaluatedNewRoll.options.isReroll = true;
        Hooks.callAll(
            "pf2e.preReroll",
            Roll.fromJSON(JSON.stringify(oldRoll.toJSON())),
            unevaluatedNewRoll,
            heroPoint,
            keep,
        );

        // Evaluate the new roll and call a second hook allowing the roll to be altered
        const newRoll = await unevaluatedNewRoll.evaluate({ async: true });
        Hooks.callAll("pf2e.reroll", Roll.fromJSON(JSON.stringify(oldRoll.toJSON())), newRoll, heroPoint, keep);

        // Keep the new roll by default; Old roll is discarded
        let keptRoll = newRoll;
        let [oldRollClass, newRollClass] = ["reroll-discard", ""];

        // Check if we should keep the old roll instead.
        if (
            (keep === "higher" && oldRoll.total > newRoll.total) ||
            (keep === "lower" && oldRoll.total < newRoll.total)
        ) {
            // If so, switch the css classes and keep the old roll.
            [oldRollClass, newRollClass] = [newRollClass, oldRollClass];
            keptRoll = oldRoll;
        }

        const degree = ((): DegreeOfSuccess | null => {
            const dc = context.dc;
            if (!dc) return null;
            if (dc.slug === "armor") {
                const targetActor = ((): ActorPF2e | null => {
                    const target = context.target;
                    if (!target?.actor) return null;

                    const maybeActor = fromUuidSync(target.actor);
                    return maybeActor instanceof ActorPF2e
                        ? maybeActor
                        : maybeActor instanceof TokenDocumentPF2e
                          ? maybeActor.actor
                          : null;
                })();
                dc.statistic = targetActor?.armorClass;
            }
            return new DegreeOfSuccess(newRoll, dc, context.dosAdjustments);
        })();
        const useNewRoll = keptRoll === newRoll && !!degree;

        if (useNewRoll && degree) {
            newRoll.options.degreeOfSuccess = degree.value;
        }

        const renders = {
            old: await CheckPF2e.renderReroll(oldRoll, { isOld: true }),
            new: await CheckPF2e.renderReroll(newRoll, { isOld: false }),
        };

        const rerollIcon = fontAwesomeIcon(heroPoint ? "hospital-symbol" : "dice");
        rerollIcon.classList.add("reroll-indicator");
        rerollIcon.dataset.tooltip = rerollFlavor;

        const oldFlavor = message.flavor ?? "";
        context.outcome = useNewRoll ? DEGREE_OF_SUCCESS_STRINGS[degree.value] : context.outcome;

        const newFlavor = useNewRoll
            ? await (async (): Promise<string> => {
                  const parsedFlavor = document.createElement("div");
                  parsedFlavor.innerHTML = oldFlavor;
                  const target = context.target ?? null;
                  const targetFlavor = await this.#createResultFlavor({ degree, target });
                  if (targetFlavor) {
                      htmlQuery(parsedFlavor, ".target-dc-result")?.replaceWith(targetFlavor);
                  }
                  for (const element of htmlQueryAll(parsedFlavor, ".roll-note")) {
                      element.remove();
                  }
                  const notes = context.notes?.map((n) => new RollNotePF2e(n)) ?? [];
                  const notesText =
                      notes
                          .filter((note) => {
                              if (!context.dc || note.outcome.length === 0) {
                                  // Always show the note if the check has no DC or no outcome is specified.
                                  return true;
                              }
                              const outcome = context.outcome ?? context.unadjustedOutcome;
                              return !!(outcome && note.outcome.includes(outcome));
                          })
                          .map((n) => n.text)
                          .join("\n") ?? "";

                  return parsedFlavor.innerHTML + notesText;
              })()
            : oldFlavor;

        // If this was an initiative roll, apply the result to the current encounter
        const initiativeRoll = message.flags.core.initiativeRoll;
        if (initiativeRoll) {
            const combatant = message.token?.combatant;
            await combatant?.parent.setInitiative(combatant.id, newRoll.total);
        }

        await message.delete({ render: false });
        await keptRoll.toMessage(
            {
                content: `<div class="${oldRollClass}">${renders.old}</div><div class="reroll-second ${newRollClass}">${renders.new}</div>`,
                flavor: `${rerollIcon.outerHTML}${newFlavor}`,
                speaker: message.speaker,
                flags: {
                    core: { initiativeRoll },
                    pf2e: systemFlags,
                },
            },
            { rollMode: context.rollMode },
        );
    }

    /**
     * Renders the reroll, highlighting the old result if it was a critical success or failure
     * @param roll  The roll that is to be rerendered
     * @param isOld This is the old roll render, so remove damage or other buttons
     */
    static async renderReroll(roll: Rolled<Roll>, { isOld }: { isOld: boolean }): Promise<string> {
        const die = roll.dice.find((d): d is Die => d instanceof Die && d.faces === 20);
        if (typeof die?.total !== "number") throw ErrorPF2e("Unexpected error inspecting d20 term");

        const html = await roll.render();
        const element = parseHTML(`<div>${html}</div>`);

        // Remove the buttons if this is the discarded roll
        if (isOld) element.querySelector(".message-buttons")?.remove();

        if (![1, 20].includes(die.total)) return element.innerHTML;

        element.querySelector(".dice-total")?.classList.add(die.total === 20 ? "success" : "failure");

        return element.innerHTML;
    }

    static async #createResultFlavor({ degree, target }: CreateResultFlavorParams): Promise<HTMLElement | null> {
        if (!degree) return null;

        const dc = degree.dc;
        const needsDCParam = !!dc.label && Number.isInteger(dc.value) && !dc.label.includes("{dc}");
        const customLabel =
            needsDCParam && dc.label ? `<dc>${game.i18n.localize(dc.label)}: {dc}</dc>` : dc.label ?? null;

        const targetActor = await (async (): Promise<ActorPF2e | null> => {
            if (!target?.actor) return null;
            if (target.actor instanceof ActorPF2e) return target.actor;

            // This is a context flag: get the actor via UUID
            const maybeActor = await fromUuid(target.actor);
            return maybeActor instanceof ActorPF2e
                ? maybeActor
                : maybeActor instanceof TokenDocumentPF2e
                  ? maybeActor.actor
                  : null;
        })();

        // Not actually included in the template, but used for creating other template data
        const targetData = await (async (): Promise<{ name: string; visible: boolean } | null> => {
            if (!target) return null;

            const token = await (async (): Promise<TokenDocumentPF2e | null> => {
                if (!target.token) return null;
                if (target.token instanceof TokenDocumentPF2e) return target.token;
                if (targetActor?.token) return targetActor.token;

                // This is from a context flag: get the actor via UUID
                return fromUuid(target.token) as Promise<TokenDocumentPF2e<ScenePF2e> | null>;
            })();

            const canSeeTokenName = (token ?? new TokenDocumentPF2e(targetActor?.prototypeToken.toObject() ?? {}))
                .playersCanSeeName;
            const canSeeName = canSeeTokenName || !game.pf2e.settings.tokens.nameVisibility;

            return {
                name: token?.name ?? targetActor?.name ?? "",
                visible: !!canSeeName,
            };
        })();

        const checkDCs = CONFIG.PF2E.checkDCs;

        // DC, circumstance adjustments, and the target's name
        const dcData = ((): ResultFlavorTemplateData["dc"] => {
            const dcSlug =
                dc.slug ?? (dc.statistic instanceof StatisticDifficultyClass ? dc.statistic.parent.slug : null);
            const dcType = game.i18n.localize(
                dc.label?.trim() ||
                    game.i18n.localize(
                        objectHasKey(checkDCs.Specific, dcSlug) ? checkDCs.Specific[dcSlug] : checkDCs.Unspecific,
                    ),
            );

            // Get any circumstance penalties or bonuses to the target's DC
            const circumstances =
                dc.statistic instanceof StatisticDifficultyClass
                    ? dc.statistic.modifiers.filter((m) => m.enabled && m.type === "circumstance")
                    : [];
            const preadjustedDC =
                circumstances.length > 0 && dc.statistic
                    ? dc.value - circumstances.reduce((total, c) => total + c.modifier, 0)
                    : dc.value ?? null;

            const visible = targetActor?.hasPlayerOwner || dc.visible || game.pf2e.settings.metagame.dcs;

            if (typeof preadjustedDC !== "number" || circumstances.length === 0) {
                const labelKey = game.i18n.localize(
                    targetData ? checkDCs.Label.WithTarget : customLabel ?? checkDCs.Label.NoTarget,
                );
                const markup = game.i18n.format(labelKey, { dcType, dc: dc.value, target: targetData?.name ?? null });

                return { markup, visible };
            }

            const adjustment = {
                preadjusted: preadjustedDC,
                direction:
                    preadjustedDC < dc.value ? "increased" : preadjustedDC > dc.value ? "decreased" : "no-change",
                circumstances: circumstances.map((c) => ({ label: c.label, value: c.modifier })),
            } as const;

            // If the adjustment direction is "no-change", the bonuses and penalties summed to zero
            const translation =
                adjustment.direction === "no-change" ? checkDCs.Label.NoChangeTarget : checkDCs.Label.AdjustedTarget;

            const markup = game.i18n.format(translation, {
                target: targetData?.name ?? game.user.name,
                dcType,
                preadjusted: preadjustedDC,
                adjusted: dc.value,
            });

            return { markup, visible, adjustment };
        })();

        // The result: degree of success (with adjustment if applicable) and visibility setting
        const resultData = ((): ResultFlavorTemplateData["result"] => {
            const offset = {
                value: new Intl.NumberFormat(game.i18n.lang, {
                    maximumFractionDigits: 0,
                    signDisplay: "always",
                    useGrouping: false,
                }).format(degree.rollTotal - dc.value),
                visible: dc.visible,
            };

            const checkOrAttack = sluggify(dc.scope ?? "Check", { camel: "bactrian" });
            const locPath = (checkOrAttack: string, dosKey: DegreeOfSuccessString) =>
                `PF2E.Check.Result.Degree.${checkOrAttack}.${dosKey}`;
            const unadjusted = game.i18n.localize(locPath(checkOrAttack, DEGREE_OF_SUCCESS_STRINGS[degree.unadjusted]));
            const [adjusted, locKey] = degree.adjustment
                ? [game.i18n.localize(locPath(checkOrAttack, DEGREE_OF_SUCCESS_STRINGS[degree.value])), "AdjustedLabel"]
                : [unadjusted, "Label"];

            const markup = game.i18n.format(`PF2E.Check.Result.${locKey}`, {
                adjusted,
                unadjusted,
                offset: offset.value,
            });
            const visible = game.pf2e.settings.metagame.results;

            return { markup, visible };
        })();

        // Render the template and replace quasi-XML nodes with visibility-data-containing HTML elements
        const rendered = await renderTemplate("systems/pf2e/templates/chat/check/target-dc-result.hbs", {
            dc: dcData,
            result: resultData,
        });

        const html = parseHTML(rendered);
        const convertXMLNode = TextEditorPF2e.convertXMLNode;

        if (targetData) {
            convertXMLNode(html, "target", { visible: targetData.visible, whose: "target" });
        }
        convertXMLNode(html, "dc", { visible: dcData.visible, whose: "target" });
        const adjustment = dcData.adjustment;
        if (adjustment) {
            convertXMLNode(html, "preadjusted", { classes: ["unadjusted"] });

            // Add circumstance bonuses/penalties for tooltip content
            const adjustedNode = convertXMLNode(html, "adjusted", {
                classes: ["adjusted", adjustment.direction],
            });
            if (!adjustedNode) throw ErrorPF2e("Unexpected error processing roll template");

            if (adjustment.circumstances.length > 0) {
                adjustedNode.dataset.tooltip = adjustment.circumstances
                    .map(
                        (a: { label: string; value: number }) =>
                            createHTMLElement("div", { children: [`${a.label}: ${signedInteger(a.value)}`] }).outerHTML,
                    )
                    .join("\n");
            }
        }
        convertXMLNode(html, "unadjusted", {
            visible: resultData.visible,
            classes: degree.adjustment ? ["unadjusted"] : [DEGREE_OF_SUCCESS_STRINGS[degree.value]],
        });
        if (degree.adjustment) {
            const adjustedNode = convertXMLNode(html, "adjusted", {
                visible: resultData.visible,
                classes: [DEGREE_OF_SUCCESS_STRINGS[degree.value], "adjusted"],
            });
            if (!adjustedNode) throw ErrorPF2e("Unexpected error processing roll template");
            adjustedNode.dataset.tooltip = degree.adjustment.label;
        }

        convertXMLNode(html, "offset", { visible: dcData.visible, whose: "target" });

        // If target and DC are both hidden from view, hide both
        if (!targetData?.visible && !dcData.visible) {
            const targetDC = html.querySelector<HTMLElement>(".target-dc");
            if (targetDC) targetDC.dataset.visibility = "gm";

            // If result is also hidden, hide everything
            if (!resultData.visible) {
                html.dataset.visibility = "gm";
            }
        }

        return html;
    }
}

interface CreateResultFlavorParams {
    degree: DegreeOfSuccess | null;
    target?: RollTarget | TargetFlag | null;
}

interface ResultFlavorTemplateData {
    dc: {
        markup: string;
        visible: boolean;
        adjustment?: {
            preadjusted: number;
            direction: "increased" | "decreased" | "no-change";
            circumstances: { label: string; value: number }[];
        };
    };
    result: {
        markup: string;
        visible: boolean;
    };
}

interface CreateTagFlavorParams {
    check: CheckModifier;
    context: CheckRollContext;
    extraTags: string[];
}

export { CheckPF2e };
export type { CheckRollCallback };
