/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";

patch(PaymentScreen.prototype, {
    async _postPushOrderResolve(order, server_ids) {
        const originalPoints = {};
        const originalBalances = {};
        const redemptionSpentByCoupon = {};
        const rewardLines = order?._get_reward_lines?.() || [];

        for (const line of rewardLines) {
            const reward = this.pos.reward_by_id?.[line.reward_id];
            if (reward?.reward_type !== "redemption" || !line.coupon_id) {
                continue;
            }
            const numId = Number(line.coupon_id);
            redemptionSpentByCoupon[numId] =
                (redemptionSpentByCoupon[numId] || 0) + (Number(line.points_cost) || 0);
        }

        for (const [couponId, spentPoints] of Object.entries(redemptionSpentByCoupon)) {
            const numId = Number(couponId);
            const pointChange = order?.couponPointChanges?.[numId];
            if (!pointChange) {
                continue;
            }
            
            originalPoints[numId] = pointChange.points;
            const coupon = this.pos.couponCache?.[numId];
            if (coupon) {
                originalBalances[numId] = coupon.balance;
            }
            const program = this.pos.program_by_id?.[pointChange.program_id];
            const correction = order._getPointsCorrection?.(program) || 0;
            
            pointChange.points = spentPoints + correction;
        }

        try {
            const result = await super._postPushOrderResolve(...arguments);
            
            for (const [couponId, spentPoints] of Object.entries(redemptionSpentByCoupon)) {
                const numId = Number(couponId);
                if (!(numId in originalBalances)) {
                    continue;
                }
                const earned = originalPoints[numId] || 0;
                const correctBalance = originalBalances[numId] + earned - spentPoints;
                const currentCoupon = this.pos.couponCache?.[numId];
                if (currentCoupon) {
                    currentCoupon.balance = correctBalance;
                }
                const partnerId = currentCoupon?.partner_id;
                const partner = partnerId
                    ? this.pos.db?.get_partner_by_id?.(partnerId)
                    : null;
                if (partner?.loyalty_cards?.[numId] !== undefined) {
                    partner.loyalty_cards[numId].points = correctBalance;
                }
            }
            return result;
        } finally {
            for (const [couponId, originalPoint] of Object.entries(originalPoints)) {
                const numId = Number(couponId);
                const pointChange = order?.couponPointChanges?.[numId];
                if (pointChange) {
                    pointChange.points = originalPoint;
                }
            }
        }
    },
});
