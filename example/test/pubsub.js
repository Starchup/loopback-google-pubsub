var app = require('../server.js');
var expect = require('chai').expect;

app.start();

describe('Test customer hook', function ()
{
    var customerId;

    before(function (done)
    {
        setTimeout(function ()
        {
            app.models.Customer.create(
            {
                name: 'James Bond'
            }).then(function (customer)
            {
                customerId = customer.id;
                done();
            }).catch(done);
        }, 1000);
    });

    it('should have created an order', function (done)
    {
        setTimeout(function ()
        {
            app.models.Order.count(
            {
                customerId: customerId
            }).then(function (count)
            {
                expect(count).to.equal(1);
                done();
            }).catch(done);
        }, 1000);
    });
});