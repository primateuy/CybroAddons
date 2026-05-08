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
import logging
import math

from odoo import api, models, fields

_logger = logging.getLogger(__name__)


def _apply_rounding(points, precision, mode):
    """Equivalente Python de _applyRounding en pos_loyalty_deduction.js.
    Redondea los puntos ganados/perdidos según la configuración del programa."""
    factor = 10 ** precision
    if mode == 'up':
        return math.ceil(points * factor) / factor
    elif mode == 'down':
        return math.floor(points * factor) / factor
    else:
        return round(points * factor) / factor


class PosOrder(models.Model):
    """To deduct the loyalty points when order is refunded"""
    _inherit = 'pos.order'

    check = fields.Boolean()
    redemption_points_deducted = fields.Boolean(default=False)

    def _compute_order_name(self):
        """Compute the loyalty points when order is refunded"""
        _logger.warning(
            "[loyalty] _compute_order_name corriendo en orden: %s | refunded_order_ids: %s",
            self.mapped('name'),
            self.mapped('refunded_order_ids.name'),
        )
        res = super()._compute_order_name()
        partner_id = self.partner_id

        # LOG: todas las líneas del pedido para entender la composición
        for line in self.lines:
            _logger.warning(
                "[loyalty] línea: product=%s qty=%s price=%s is_reward=%s reward_id=%s coupon_id=%s refunded_orderline_id=%s",
                line.product_id.name, line.qty, line.price_subtotal_incl,
                line.is_reward_line, line.reward_id.id if line.reward_id else None,
                line.coupon_id.id if line.coupon_id else None,
                line.refunded_orderline_id.id if line.refunded_orderline_id else None,
            )

        # FIX: filtrar SOLO las líneas vinculadas a la devolución (refunded_orderline_id).
        # En un pedido mixto (reembolso + compra nueva), Odoo nativo ya suma los puntos
        # del producto nuevo por su propio flujo. Si incluimos esas líneas aquí también,
        # los puntos se cuentan doble. El filtro por refunded_orderline_id garantiza que
        # solo procesamos las líneas que pertenecen al reembolso.
        # También se excluyen líneas de reward/redemption para no contar el descuento
        # por canje como si fuera una línea de producto.
        refund_only_lines = self.lines.filtered(
            lambda x: x.refunded_orderline_id
            and not x.is_reward_line
            and not x.reward_id
            and not x.coupon_id
        )
        li = [line.mapped('price_subtotal_incl') for line in refund_only_lines]
        _logger.warning("[loyalty] li resultante (solo líneas de devolución): %s", li)

        reward_line = self.refunded_order_ids.lines.filtered(
            lambda x: x.is_reward_line)
        points_cost = []
        for line in reward_line:
            dict = {}
            dict.update({
                line.coupon_id.id: line.points_cost
            })
            points_cost.append(dict)
        if self.refunded_order_ids:
            cards = self.env['loyalty.card'].search(
                [('partner_id', '=', partner_id.id)])

            for program in cards:
                _logger.warning("[loyalty] card=%s puntos antes=%s", program.id, program.points)

                # Restaurar puntos de redemption gastados en la venta original.
                # Se aplica exacto, sin redondeo, porque es una devolución 1:1.
                if not self.refunded_order_ids.check:
                    for point in points_cost:
                        for key, values in point.items():
                            if program.id == key:
                                _logger.warning("[loyalty] restaurando redemption: card=%s += %s", program.id, point[key])
                                program.points += point[key]
                                self.refunded_order_ids.check = True

                # Calcular delta de puntos ganados/perdidos por reglas.
                # Se acumula en `rules_delta` para poder aplicar el redondeo
                # del programa antes de escribir en program.points, igual que
                # en _applyRounding de pos_loyalty_deduction.js.
                rules_delta = 0
                for rule in program.program_id.rule_ids:
                    if rule.reward_point_mode == 'money':
                        points_granted = rule.reward_point_amount
                        reward_points = [sum(sublist) * points_granted for
                                         sublist in li]
                        _logger.warning("[loyalty] money mode: card=%s li=%s reward_points=%s", program.id, li, reward_points)
                        # FIX: el código original usaba reward_points[0], procesando
                        # solo la primera línea del pedido. Con sum() se aplican
                        # los puntos de todas las líneas de producto correctamente.
                        rules_delta += sum(reward_points)
                    elif rule.reward_point_mode == 'order':
                        reward_points = rule.reward_point_amount
                        reward_line_ids = len(reward_line)
                        ordered_qty = sum(self.refunded_order_ids.lines.mapped(
                            'qty')) - reward_line_ids
                        refunded_qty = sum(
                            self.refunded_order_ids.lines.filtered(
                                lambda x: not x.is_reward_line).mapped(
                                'refunded_qty'))
                        _logger.warning("[loyalty] order mode: card=%s ordered_qty=%s refunded_qty=%s", program.id, ordered_qty, refunded_qty)
                        # FIX: el loop itera todas las tarjetas del cliente, no solo
                        # las involucradas en esta venta. Sin el guard `>= reward_points`,
                        # tarjetas con 0 puntos de otros programas quedaban en negativo.
                        if ordered_qty == refunded_qty and program.points >= reward_points:
                            rules_delta -= reward_points
                    elif rule.reward_point_mode == 'unit':
                        points_granted = rule.reward_point_amount
                        # Mismo criterio que money mode: solo líneas de la devolución
                        # para no contar doble las unidades del producto nuevo.
                        qty = sum(refund_only_lines.mapped('qty'))
                        reward_points = qty * points_granted
                        _logger.warning("[loyalty] unit mode: card=%s qty=%s reward_points=%s", program.id, qty, reward_points)
                        rules_delta += reward_points

                # Aplicar redondeo al delta si el programa tiene redemption reward
                # con modo de redondeo configurado (mismo criterio que el JS).
                redemption_reward = program.program_id.reward_ids.filtered(
                    lambda r: r.reward_type == 'redemption'
                )
                if redemption_reward and redemption_reward[0].rounding_mode:
                    rw = redemption_reward[0]
                    # FIX: aplicar el redondeo sobre el valor absoluto del delta y
                    # luego negar. Si se redondea el negativo directamente,
                    # floor(-19.6) = -20 pero la venta ganó floor(19.6) = 19,
                    # causando una diferencia de -1 punto por ciclo venta+reembolso.
                    abs_rounded = _apply_rounding(abs(rules_delta), rw.rounding_precision or 0, rw.rounding_mode)
                    rules_delta = -abs_rounded if rules_delta < 0 else abs_rounded
                    _logger.warning("[loyalty] redondeo aplicado: card=%s delta_redondeado=%s mode=%s precision=%s", program.id, rules_delta, rw.rounding_mode, rw.rounding_precision)

                program.points += rules_delta
                _logger.warning("[loyalty] card=%s puntos despues=%s", program.id, program.points)

        return res

    @api.model
    def create_from_ui(self, orders, draft=False):
        """Persist Redemption point spend independently of frontend post-process."""
        result = super().create_from_ui(orders, draft)
        if draft:
            return result

        order_ids = [
            order_data.get('id')
            for order_data in (result or [])
            if isinstance(order_data, dict) and order_data.get('id')
        ]
        if not order_ids:
            return result

        pos_orders = self.browse(order_ids).filtered(
            lambda order: not order.redemption_points_deducted
        )
        for order in pos_orders:
            remaining_points = self.env['pos.order.line']._deduct_redemption_points_for_order(order)
            if remaining_points:
                order.redemption_points_deducted = True
        return result

    @api.model
    def _process_order(self, order, draft, existing_order):
        """After saving the order, deduct loyalty points for unlinked refunds
        (orders with negative quantities entered directly in the POS, without
        linking to an original order through the ticket screen).
        """
        order_id = super()._process_order(order, draft, existing_order)
        if draft:
            return order_id
        pos_order = self.browse(order_id)
        if pos_order.refunded_order_ids or not pos_order.partner_id:
            return order_id
        non_reward_lines = pos_order.lines.filtered(lambda x: not x.is_reward_line)
        if not any(line.qty < 0 for line in non_reward_lines):
            return order_id
        cards = self.env['loyalty.card'].search(
            [('partner_id', '=', pos_order.partner_id.id)])
        refund_total = sum(non_reward_lines.mapped('price_subtotal_incl'))
        refund_qty = sum(non_reward_lines.mapped('qty'))
        for card in cards:
            for rule in card.program_id.rule_ids:
                if rule.reward_point_mode == 'money':
                    card.points += refund_total * rule.reward_point_amount
                elif rule.reward_point_mode == 'unit':
                    card.points += refund_qty * rule.reward_point_amount
                elif rule.reward_point_mode == 'order':
                    card.points -= rule.reward_point_amount
        return order_id
