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
import ast
import json
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

    @staticmethod
    def _forum_rule_matches_partner(rule, partner):
        """Verifica si el partner cumple el customer_domain de la regla.
        Replica la lógica de ruleMatchesPartnerCustomerDomain en JS:
        si no hay dominio → aplica; si hay dominio → el partner debe cumplirlo.
        Usa filtered_domain para no hacer una query SQL extra."""
        domain_str = getattr(rule, 'customer_domain', None)
        if not domain_str or str(domain_str).strip() in ('', '[]', 'null'):
            return True
        if not partner:
            return False
        try:
            try:
                domain = json.loads(domain_str)
            except (json.JSONDecodeError, TypeError):
                domain = ast.literal_eval(domain_str)
            if not domain:
                return True
            return bool(partner.filtered_domain(domain))
        except Exception:
            _logger.warning(
                "[loyalty] No se pudo evaluar customer_domain '%s' para regla %s, se permite por defecto",
                domain_str, rule.id
            )
            return True

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

        # Líneas de producto del reembolso: vinculadas a la orden original,
        # sin ser reward/redemption. En un pedido mixto Odoo nativo ya suma los
        # puntos del producto nuevo, por eso filtramos por refunded_orderline_id.
        refund_only_lines = self.lines.filtered(
            lambda x: x.refunded_orderline_id
            and not x.is_reward_line
            and not x.reward_id
            and not x.coupon_id
        )

        # Líneas de descuento promocional del reembolso.
        # Odoo re-aplica las promociones automáticamente al crear el reembolso,
        # generando líneas nuevas con precio POSITIVO y sin refunded_orderline_id.
        # Precio positivo = descuento invertido: -3980 + 717.59 = -3262.41
        # → misma base que usó la venta original para calcular los puntos.
        # En pedidos mixtos los descuentos nuevos tienen precio negativo → excluidos.
        refund_discount_lines = self.lines.filtered(
            lambda x: x.is_reward_line
            and x.reward_id
            and x.reward_id.reward_type == 'discount'
            and x.price_subtotal_incl > 0
            and x.reward_id.refund_allowed
        )
        net_refund_total = (
            sum(refund_only_lines.mapped('price_subtotal_incl'))
            + sum(refund_discount_lines.mapped('price_subtotal_incl'))
        )
        _logger.warning(
            "[loyalty] refund lines total=%s discount lines total=%s net_refund_total=%s",
            sum(refund_only_lines.mapped('price_subtotal_incl')),
            sum(refund_discount_lines.mapped('price_subtotal_incl')),
            net_refund_total,
        )

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
                    # Respetar el customer_domain de la regla: si el partner no cumple
                    # el dominio, esta regla no le aplica → no se toca el delta.
                    # Replica ruleMatchesPartnerCustomerDomain() del módulo JS.
                    if not self._forum_rule_matches_partner(rule, partner_id):
                        _logger.warning(
                            "[loyalty] regla %s excluida por customer_domain para partner %s",
                            rule.id, partner_id.id,
                        )
                        continue
                    if rule.reward_point_mode == 'money':
                        # Usar el importe neto (producto + descuentos revertidos) para
                        # que la deducción sea simétrica con los puntos ganados en la venta.
                        points_delta = net_refund_total * rule.reward_point_amount
                        _logger.warning(
                            "[loyalty] money mode: card=%s net_refund_total=%s points_delta=%s",
                            program.id, net_refund_total, points_delta,
                        )
                        rules_delta += points_delta
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
            rules_delta = 0
            for rule in card.program_id.rule_ids:
                # Mismo guard que en _compute_order_name: si la regla tiene
                # customer_domain y el partner no lo cumple, se omite.
                if not self._forum_rule_matches_partner(rule, pos_order.partner_id):
                    continue
                if rule.reward_point_mode == 'money':
                    rules_delta += refund_total * rule.reward_point_amount
                elif rule.reward_point_mode == 'unit':
                    rules_delta += refund_qty * rule.reward_point_amount
                elif rule.reward_point_mode == 'order':
                    rules_delta -= rule.reward_point_amount
            # Aplicar redondeo antes de escribir, igual que en _compute_order_name.
            redemption_reward = card.program_id.reward_ids.filtered(
                lambda r: r.reward_type == 'redemption'
            )
            if redemption_reward and redemption_reward[0].rounding_mode:
                rw = redemption_reward[0]
                abs_rounded = _apply_rounding(
                    abs(rules_delta), rw.rounding_precision or 0, rw.rounding_mode
                )
                rules_delta = -abs_rounded if rules_delta < 0 else abs_rounded
            card.points += rules_delta
        return order_id
