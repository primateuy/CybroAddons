    /** @odoo-module */
import { AbstractAwaitablePopup } from "@point_of_sale/app/popup/abstract_awaitable_popup";
import { _t } from "@web/core/l10n/translation";
import { useRef,useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";

export class RewardPopup extends AbstractAwaitablePopup {
    static template = "RedeemPoint";
    setup(){
        this.orm = useService("orm");
        this.popup = useService("popup");
        this.state = useState({
            value:'' ,
            redeemPoints:''
        })
        this.points = useRef("points");
    }

    toRedeem(ev) {
        // Validación en tiempo real al cambiar el valor del input.
        // Muestra el error visualmente pero no bloquea; el bloqueo real
        // está en save() para cubrir el caso en que el usuario no toque
        // el input antes de presionar Agregar.
        ev.state.redeemPoints = ev.points.el.value;
        const entered = parseFloat(ev.state.redeemPoints);
        if (isNaN(entered)) {
            ev.popup.add(ErrorPopup, {
                body: _t("Los puntos a canjear deben ser un número."),
            });
        } else if (ev.props.min_redemption_points > 0 && entered < ev.props.min_redemption_points) {
            ev.popup.add(ErrorPopup, {
                body: _t("Debe canjear al menos %s puntos.", ev.props.min_redemption_points),
            });
        } else if (entered > ev.props.max_redemption_points) {
            ev.popup.add(ErrorPopup, {
                body: _t("Los puntos a canjear no pueden superar el máximo permitido."),
            });
        } else if (entered > ev.props.available_points) {
            ev.popup.add(ErrorPopup, {
                body: _t(
                    "No puede canjear %s puntos: el cliente solo tiene %s puntos disponibles.",
                    entered,
                    ev.props.available_points
                ),
            });
        }
    }

    save(props, ev) {
        // Validación definitiva al presionar Agregar. Repite los mismos controles
        // que toRedeem para garantizar que nunca se aplique un canje inválido,
        // incluso si el usuario no modificó el input y toRedeem no se ejecutó.
        const entered = parseFloat(ev.state.redeemPoints);
        if (isNaN(entered) || entered <= 0) {
            ev.popup.add(ErrorPopup, {
                body: _t("Ingrese una cantidad válida de puntos para canjear."),
            });
            return;
        }
        if (props.min_redemption_points > 0 && entered < props.min_redemption_points) {
            ev.popup.add(ErrorPopup, {
                body: _t("Debe canjear al menos %s puntos.", props.min_redemption_points),
            });
            return;
        }
        if (entered > props.max_redemption_points) {
            ev.popup.add(ErrorPopup, {
                body: _t("Los puntos a canjear no pueden superar el máximo permitido."),
            });
            return;
        }
        if (entered > props.available_points) {
            // Bloqueo principal: el cliente no puede gastar puntos que no tiene
            // confirmados en el backend, aunque el frontend los muestre como ganados
            // en la orden actual (esos aún no están persistidos).
            ev.popup.add(ErrorPopup, {
                body: _t(
                    "No puede canjear %s puntos: el cliente solo tiene %s puntos disponibles.",
                    entered,
                    props.available_points
                ),
            });
            return;
        }
        const selectedReward = props.selected_reward;
        selectedReward.reward.pointsToRedeem = entered;
        props.close();
        props.order.selectedCoupon = selectedReward.coupon_id;
        props.order.pointsCost = entered;
        return props.property._applyReward(
            selectedReward.reward,
            selectedReward.coupon_id,
            selectedReward.potentialQty
        );
    }
    static defaultProps = {
        closePopup: _t("Cancel"),
        confirmText: _t("Save"),
        title: _t("Customer Details"),
    };
}