import colors from 'colors';

export default {
    error(msg: string) {
        console.log(colors.red(`【Error】${msg}`));
    },
    warn(msg: string) {
        console.log(colors.yellow(`【Warn】${msg}`));
    },
    trace(msg: string) {
        console.log(colors.green(`【Trace】${msg}`));
    },
}