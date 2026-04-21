# -*- coding: utf-8 -*-
#############################################################################
#
#    Cybrosys Technologies Pvt. Ltd.
#
#    Copyright (C) 2024-TODAY Cybrosys Technologies(<https://www.cybrosys.com>)
#    Author: Cybrosys Techno Solutions(<https://www.cybrosys.com>)
#
#    You can modify it under the terms of the GNU LESSER
#    GENERAL PUBLIC LICENSE (LGPL v3), Version 3.
#
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU LESSER GENERAL PUBLIC LICENSE (LGPL v3) for more details.
#
#    You should have received a copy of the GNU LESSER GENERAL PUBLIC LICENSE
#    (LGPL v3) along with this program.
#    If not, see <http://www.gnu.org/licenses/>.
#
#############################################################################
from odoo import api, models, fields


class PosOrderLine(models.Model):
    """To Show the redeemed points in the redemption history"""
    _inherit = 'pos.order.line'

    points_remaining = fields.Float(string="Points Remaining",
                                    help="Remaining points after claming the "
                                         "reward")

    @api.model
    def remaining_points(self, balance, token):
        """Remaining points calculated after claiming the reward"""
        order = self.env['pos.order'].search([('access_token', '=', token[0])])
        pos_order_line = self.env['pos.order.line'].search(
            [('is_reward_line', '=', 'true'), ('order_id', '=', order.id)])
        pos_order_line.points_remaining = balance[0]

    @api.model
    def _deduct_redemption_points_for_order(self, order):
        """Persist spent Redemption points from saved POS reward lines."""
        if not order:
            return {}

        reward_lines = order.lines.filtered(
            lambda line: (
                line.is_reward_line
                and line.coupon_id
                and line.reward_id
                and line.reward_id.reward_type == 'redemption'
            )
        )
        if not reward_lines:
            return {}

        remaining_points = {}
        for loyalty_card in reward_lines.mapped('coupon_id').sudo():
            card_reward_lines = reward_lines.filtered(
                lambda line: line.coupon_id.id == loyalty_card.id
            )
            spent_points = sum(card_reward_lines.mapped('points_cost'))
            if spent_points:
                loyalty_card.write({'points': loyalty_card.points - spent_points})
            remaining_points[loyalty_card.id] = loyalty_card.points

        for reward_line in reward_lines:
            reward_line.points_remaining = remaining_points.get(
                reward_line.coupon_id.id, reward_line.points_remaining
            )
        return remaining_points

    @api.model
    def deduct_loyalty_points(self, coupon_id, points_spent, token):
        """Deduct all claimed reward points from the order loyalty cards.

        The POS screen can contain multiple reward lines from different
        programs/cards. We therefore recompute the deduction from the saved
        order lines instead of relying on the last selected reward only.
        """
        order = self.env['pos.order'].search([('access_token', '=', token[0])], limit=1)
        if not order:
            return
        return self._deduct_redemption_points_for_order(order)
