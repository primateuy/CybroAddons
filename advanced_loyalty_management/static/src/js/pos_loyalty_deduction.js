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

                        programs.rules.forEach((rule) => {
                            ruleId.push(rule.id);
                            // orderModeProcessed evita descontar el punto de orden
                            // más de una vez cuando hay múltiples líneas negativas.
                            let orderModeProcessed = false;
                            for (let line of unlinkedRefundLines) {
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
                                    case "order":
                                        if (!orderModeProcessed) {
                                            res += rule.reward_point_amount;
                                            orderModeProcessed = true;
                                        }
                                        break;
                                }
                            }
                        });

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
            }
        }

        // Guardar en el store global para que export_for_printing lo incluya
        // en el recibo a través de pos_loyalty_deduction_receipt.js.
        this.pos.lostPoints = valsList;
        return valsList;
    },
});