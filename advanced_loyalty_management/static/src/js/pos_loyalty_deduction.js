/** @odoo-module **/
import { Order } from "@point_of_sale/app/store/models";
import { roundPrecision } from "@web/core/utils/numbers";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";

// Evalúa un nodo de dominio Odoo contra un partner cargado en el POS.
// Replica la lógica de evalDomainNode en pos_forum_loyalty_customer_domain.js
// para que deductLoyaltyPoints respete el mismo filtro de dominio que pointsForPrograms.
function _evalDomainNode(partner, node) {
    if (!Array.isArray(node)) return true;
    if (
        typeof node[0] === "string" &&
        !["&", "|", "!"].includes(node[0]) &&
        node.length === 3
    ) {
        const [field, op, val] = node;
        const raw = partner?.[field];
        // Many2many (ej: category_id): puede ser [id, ...] o [[id, "name"], ...]
        const ids = Array.isArray(raw)
            ? raw.map((x) => (Array.isArray(x) ? x[0] : x))
            : raw !== undefined && raw !== false && raw !== null
            ? [raw]
            : [];
        const toId = (v) => (Array.isArray(v) ? v[0] : v);
        switch (op) {
            case "=":
                return ids.length ? ids.includes(toId(val)) : raw === val;
            case "!=":
                return ids.length ? !ids.includes(toId(val)) : raw !== val;
            case "in":
                return (Array.isArray(val) ? val : []).some(
                    (v) => ids.includes(v) || raw === v
                );
            case "not in":
                return !(Array.isArray(val) ? val : []).some(
                    (v) => ids.includes(v) || raw === v
                );
            default:
                return true;
        }
    }
    const token = node[0];
    if (token === "!") return !_evalDomainNode(partner, node[1]);
    if (token === "&")
        return _evalDomainNode(partner, node[1]) && _evalDomainNode(partner, node[2]);
    if (token === "|")
        return _evalDomainNode(partner, node[1]) || _evalDomainNode(partner, node[2]);
    return node.every((item) => _evalDomainNode(partner, item));
}

// Devuelve true si el partner cumple el customer_domain de la regla.
// Si no hay dominio o no se puede parsear, permite por defecto.
function _ruleMatchesPartner(partner, rule) {
    if (!rule.customer_domain || rule.customer_domain === "[]") return true;
    if (!partner) return false;
    try {
        const domain = JSON.parse(rule.customer_domain);
        if (!domain || !domain.length) return true;
        return _evalDomainNode(partner, domain);
    } catch {
        return true;
    }
}

// Aplica redondeo a los puntos según el modo configurado en el programa.
// Equivalente en Python: _apply_rounding() en pos_refund.py.
function _applyRounding(points, precision, mode) {
    const factor = Math.pow(10, precision);
    switch (mode) {
        case "up":
            return Math.ceil(points * factor) / factor;
        case "down":
            return Math.floor(points * factor) / factor;
        default:
            return Math.round(points * factor) / factor;
    }
}

patch(Order.prototype, {

    deductLoyaltyPoints(product) {
        // Separa las líneas del pedido en dos grupos mutuamente excluyentes:
        // - refundedLines: devolución vinculada (cada línea tiene refunded_orderline_id)
        // - unlinkedRefundLines: devolución manual con qty negativa sin orden de origen
        let refundedLines = this.get_orderlines().filter((line) => line.refunded_orderline_id);
        let unlinkedRefundLines =
            refundedLines.length === 0
                ? this.get_orderlines().filter(
                      (line) => !line.is_reward_line && line.get_quantity() < 0
                  )
                : [];

        let valsList = [];

        if (this.couponPointChanges) {
            if (refundedLines.length > 0) {
                // --- DEVOLUCIÓN VINCULADA ---
                // rewardPoints viene del localStorage donde se guardaron los
                // points_cost de las líneas de reward de la orden original.
                let rewardPoints = JSON.parse(localStorage.getItem("pointsCost"));

                // Descuentos promocionales re-aplicados por Odoo al crear el reembolso:
                // aparecen como is_reward_line sin refunded_orderline_id y precio positivo
                // (el descuento original era negativo, ahora está invertido).
                // Solo se incluyen si refund_allowed != false (igual que pos_refund.py).
                const reversedDiscountTotal = this.get_orderlines()
                    .filter((line) => {
                        if (!line.is_reward_line || line.refunded_orderline_id || line.get_price_with_tax() <= 0) {
                            return false;
                        }
                        const reward = this.pos.rewards.find((r) => r.id === line.reward_id);
                        return !reward || reward.refund_allowed !== false;
                    })
                    .reduce((sum, line) => sum + line.get_price_with_tax(), 0);

                this.getLoyaltyPoints(true).forEach((record) => {
                    let { couponId, points, program } = record;
                    if (couponId > 0) {
                        let loyaltyCard = this.pos.couponCache[couponId];
                        let programs = this.pos.program_by_id[loyaltyCard.program_id];
                        let balance = loyaltyCard.balance;
                        let res = 0;
                        let ruleId = [];

                        const partner = this.get_partner();
                        // Solo procesar reglas cuyo customer_domain aplica al partner.
                        // Mismo filtro que pos_forum_loyalty_customer_domain usa en pointsForPrograms.
                        const matchingRules = programs.rules.filter((r) =>
                            _ruleMatchesPartner(partner, r)
                        );
                        if (!matchingRules.length) {
                            // Ninguna regla aplica → el programa no afecta a este cliente,
                            // no mostrar puntos negativos.
                            return;
                        }

                        // Calcular cuántos puntos se ganaron en la venta original
                        // para saber cuántos hay que restar en el reembolso.
                        // res queda positivo = puntos a descontar del balance.
                        matchingRules.forEach((rule) => {
                            ruleId.push(rule.id);
                            let totalQuantity = 0;
                            for (let line of refundedLines) {
                                const refundedQty =
                                    line.pos.toRefundLines[line.refunded_orderline_id]
                                        ?.orderline?.refundedQty - line.get_quantity();
                                switch (rule.reward_point_mode) {
                                    case "money":
                                        res -= roundPrecision(
                                            rule.reward_point_amount * line.get_price_with_tax(),
                                            0.01
                                        );
                                        break;
                                    case "unit":
                                        res -= rule.reward_point_amount * line.get_quantity();
                                        break;
                                    default:
                                        totalQuantity +=
                                            line.pos.toRefundLines[line.refunded_orderline_id]
                                                ?.orderline?.qty || 0;
                                        res +=
                                            totalQuantity === refundedQty
                                                ? rule.reward_point_amount
                                                : 0;
                                }
                            }
                            // Ajuste por descuentos promocionales revertidos.
                            // Solo aplica al modo money; unit y order ya usan qty/orden.
                            if (rule.reward_point_mode === "money" && reversedDiscountTotal !== 0) {
                                res -= roundPrecision(
                                    rule.reward_point_amount * reversedDiscountTotal,
                                    0.01
                                );
                            }
                        }); // fin matchingRules.forEach

                        // FIX: el loop original iteraba refundedLines y restaba
                        // pointscost una vez por cada línea que cumpliera la condición,
                        // causando doble (o múltiple) deducción. Con some() la resta
                        // ocurre una sola vez sin importar cuántas líneas coincidan.
                        const hasFullyRefundedLine = refundedLines.some(
                            (line) =>
                                line.pos.toRefundLines[line.refunded_orderline_id]?.orderline
                                    ?.refundedQty === 0
                        );
                        if (hasFullyRefundedLine && rewardPoints.length !== 0) {
                            for (var pointscost of rewardPoints) {
                                if (pointscost[couponId]) {
                                    res -= pointscost[couponId];
                                }
                            }
                        }

                        // Aplicar redondeo al total de puntos perdidos si el programa
                        // tiene una redemption reward con modo de redondeo configurado.
                        const redemptionReward = this.pos.rewards.find(
                            (r) => r.program_id === program && r.reward_type === "redemption"
                        );
                        if (redemptionReward?.rounding_mode) {
                            res = _applyRounding(
                                res,
                                redemptionReward.rounding_precision ?? 0,
                                redemptionReward.rounding_mode
                            );
                        }

                        // Orden mixta: hay líneas de venta regulares además del reembolso.
                        // Usar puntos netos (ganados en la venta − perdidos en el reembolso)
                        // para mostrar un único bloque en la UI en lugar de dos separados.
                        const hasRegularSaleLines = this.get_orderlines().some(
                            (l) => !l.is_reward_line && !l.refunded_orderline_id && l.get_quantity() > 0
                        );
                        if (hasRegularSaleLines) {
                            res -= points.won || 0;
                        }

                        let currentBalance = balance - res;
                        valsList.push({
                            lostPoint: res,
                            newPoint: currentBalance.toFixed(2),
                            programName: programs.name,
                            ruleId: ruleId,
                        });
                    }
                });
            } else if (unlinkedRefundLines.length > 0) {
                // --- DEVOLUCIÓN DESVINCULADA ---
                // Líneas con qty negativa ingresadas manualmente sin referenciar
                // una orden original. Se recalculan los puntos según las reglas.
                this.getLoyaltyPoints(true).forEach((record) => {
                    let { couponId, points, program } = record;
                    if (couponId > 0) {
                        let loyaltyCard = this.pos.couponCache[couponId];
                        let programs = this.pos.program_by_id[loyaltyCard.program_id];
                        let balance = loyaltyCard.balance;
                        let res = 0;
                        let ruleId = [];

                        // Para money y unit usar el NETO de todas las líneas no-reward,
                        // igual que _process_order en Python usa sum(ALL non_reward_lines).
                        // Un pedido mixto (producto positivo + devolución manual) debe
                        // mostrar el delta neto, no solo la parte negativa.
                        const allNonRewardLines = this.get_orderlines().filter(
                            (line) => !line.is_reward_line
                        );

                        const partnerUnlinked = this.get_partner();
                        const matchingRulesUnlinked = programs.rules.filter((r) =>
                            _ruleMatchesPartner(partnerUnlinked, r)
                        );
                        if (!matchingRulesUnlinked.length) {
                            return;
                        }

                        matchingRulesUnlinked.forEach((rule) => {
                            ruleId.push(rule.id);
                            switch (rule.reward_point_mode) {
                                case "money":
                                    for (let line of allNonRewardLines) {
                                        res -= roundPrecision(
                                            rule.reward_point_amount * line.get_price_with_tax(),
                                            0.01
                                        );
                                    }
                                    break;
                                case "unit":
                                    for (let line of allNonRewardLines) {
                                        res -= rule.reward_point_amount * line.get_quantity();
                                    }
                                    break;
                                case "order":
                                    // Un solo ajuste de orden sin importar cuántas líneas hay.
                                    res += rule.reward_point_amount;
                                    break;
                            }
                        });

                        // Aplicar redondeo con el patrón de valor absoluto, igual que
                        // _process_order en Python, para que un pedido neto positivo
                        // (ganancia de puntos) también se redondee correctamente.
                        const redemptionReward = this.pos.rewards.find(
                            (r) => r.program_id === program && r.reward_type === "redemption"
                        );
                        if (redemptionReward?.rounding_mode) {
                            const absRounded = _applyRounding(
                                Math.abs(res),
                                redemptionReward.rounding_precision ?? 0,
                                redemptionReward.rounding_mode
                            );
                            res = res < 0 ? -absRounded : absRounded;
                        }

                        let currentBalance = balance - res;
                        valsList.push({
                            lostPoint: res,
                            newPoint: currentBalance.toFixed(2),
                            programName: programs.name,
                            ruleId: ruleId,
                        });
                    }
                });
            }
        }

        // Guardar en la orden (no en this.pos) para que cada orden tenga sus propios
        // puntos perdidos. Si se guardara en this.pos, la venta siguiente mostraría
        // los puntos del reembolso anterior en su recibo.
        this.lostPoints = valsList;
        return valsList;
    },

    // True cuando la orden tiene líneas de reembolso o total negativo.
    // Usado en el template para suprimir el bloque estándar de pos_loyalty
    // y mostrar en su lugar el bloque unificado de puntos netos.
    _isRefundOrMixedOrder() {
        const lines = this.get_orderlines();
        return (
            lines.some((l) => l.refunded_orderline_id && l.get_quantity() !== 0) ||
            this.get_total_with_tax() < 0
        );
    },
});