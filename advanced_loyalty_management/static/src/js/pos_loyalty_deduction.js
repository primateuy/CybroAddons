/** @odoo-module **/
import { Order } from "@point_of_sale/app/store/models";
import { roundPrecision } from "@web/core/utils/numbers";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";

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
                // Hay que sumarlos a la base de puntos igual que en pos_refund.py.
                const reversedDiscountTotal = this.get_orderlines()
                    .filter(
                        (line) =>
                            line.is_reward_line &&
                            !line.refunded_orderline_id &&
                            line.get_price_with_tax() > 0
                    )
                    .reduce((sum, line) => sum + line.get_price_with_tax(), 0);

                this.getLoyaltyPoints().forEach((record) => {
                    let { couponId, points, program } = record;
                    if (couponId > 0) {
                        let loyaltyCard = this.pos.couponCache[couponId];
                        let programs = this.pos.program_by_id[loyaltyCard.program_id];
                        let balance = loyaltyCard.balance;
                        let res = 0;
                        let ruleId = [];

                        // Calcular cuántos puntos se ganaron en la venta original
                        // para saber cuántos hay que restar en el reembolso.
                        // res queda positivo = puntos a descontar del balance.
                        programs.rules.forEach((rule) => {
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
                        });

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
                this.getLoyaltyPoints().forEach((record) => {
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

                        programs.rules.forEach((rule) => {
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
});